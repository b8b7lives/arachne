// Golden-fixture generator: runs the upstream mapartcraft workers headless
// and captures their outputs for arachne-core parity tests. Rebuild:
//   node gen-fixtures.mjs        (requires ../../analysis/mapartcraft/upstream)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const UP = "../../analysis/mapartcraft/upstream/src/components/mapart";
const OUT = "fixtures";
mkdirSync(OUT, { recursive: true });

const coloursJSON = JSON.parse(readFileSync(`${UP}/json/coloursJSON.json`));
const MapModes = JSON.parse(readFileSync(`${UP}/json/mapModes.json`));
const WhereSupportBlocksModes = JSON.parse(readFileSync(`${UP}/json/whereSupportBlocksModes.json`));
const DitherMethods = JSON.parse(readFileSync(`${UP}/json/ditherMethods.json`));

const VERSION = { MCVersion: "1.20", NBTVersion: 3463 };

function runWorker(file, message) {
  const results = [];
  const ctx = vm.createContext({
    postMessage: (m) => results.push(m),
    console,
  });
  vm.runInContext(readFileSync(`${UP}/workers/${file}`, "utf8"), ctx);
  ctx.onmessage({ data: message });
  return results;
}

// deterministic 128x128 test image
const W = 128, H = 128;
const imageData = new Uint8ClampedArray(W * H * 4);
for (let z = 0; z < H; z++) {
  for (let x = 0; x < W; x++) {
    const i = 4 * (z * W + x);
    imageData[i] = (x * 2 + ((z * 7) % 61)) % 256;
    imageData[i + 1] = (z * 2 + Math.floor(127 * Math.sin(x / 9)) + 128) % 256;
    imageData[i + 2] = (x + z + ((x * z) % 37)) % 256;
    imageData[i + 3] = 255;
  }
}

const selectedBlocks = {};
for (const [csId, cs] of Object.entries(coloursJSON)) {
  selectedBlocks[csId] = "-1";
  for (const [blockId, block] of Object.entries(cs.blocks)) {
    if (VERSION.MCVersion in block.validVersions) {
      selectedBlocks[csId] = blockId;
      break;
    }
  }
}

const selection = {};
for (const [csId, blockId] of Object.entries(selectedBlocks)) {
  if (blockId === "-1") continue;
  const block = coloursJSON[csId].blocks[blockId];
  let vv = block.validVersions[VERSION.MCVersion];
  if (typeof vv === "string") vv = block.validVersions[vv.slice(1)];
  selection[csId] = {
    color_id: coloursJSON[csId].mapdatId,
    block_id: vv.NBTName,
    properties: vv.NBTArgs,
    support_mandatory: block.supportBlockMandatory,
  };
}
writeFileSync(`${OUT}/selection.json`, JSON.stringify(selection, null, 1));

const exactColour = new Map();
for (const [csId, cs] of Object.entries(coloursJSON)) {
  for (const [toneKey, rgb] of Object.entries(cs.tonesRGB)) {
    exactColour.set((rgb[0] << 16) + (rgb[1] << 8) + rgb[2], [cs.mapdatId, toneKey]);
  }
}

function runCanvas(mode, staircasing, whereSupport) {
  const msg = {
    head: "PIXELS",
    body: {
      coloursJSON, MapModes, WhereSupportBlocksModes, DitherMethods,
      canvasImageData: { data: new Uint8ClampedArray(imageData), width: W, height: H },
      selectedBlocks,
      optionValue_modeNBTOrMapdat: mode,
      optionValue_mapSize_x: 1,
      optionValue_mapSize_y: 1,
      optionValue_staircasing: staircasing,
      optionValue_whereSupportBlocks: whereSupport,
      optionValue_transparency: false,
      optionValue_transparencyTolerance: 128,
      optionValue_betterColour: true,
      optionValue_dithering: DitherMethods.FloydSteinberg.uniqueId,
    },
  };
  const out = runWorker("mapCanvas.jsworker", msg);
  return out.find((m) => m.head === "PIXELS_MATERIALS_CURRENTSELECTEDBLOCKS").body;
}

function gridOf(pixels) {
  const colors = [], tones = [];
  const toneNum = { dark: 0, normal: 1, light: 2, unobtainable: 3 };
  for (let i = 0; i < W * H; i++) {
    const key = (pixels.data[4 * i] << 16) + (pixels.data[4 * i + 1] << 8) + pixels.data[4 * i + 2];
    const hit = exactColour.get(key);
    if (!hit) throw new Error(`unmatched pixel RGB at ${i}`);
    colors.push(hit[0]);
    tones.push(toneNum[hit[1]]);
  }
  return { width: W, height: H, colors, tones };
}

function materialsOf(body) {
  const map = body.maps[0][0];
  const mats = {};
  for (const [csId, count] of Object.entries(map.materials)) {
    if (count > 0) mats[coloursJSON[csId].mapdatId] = count;
  }
  return { materials: mats, support_count: map.supportBlockCount };
}

function runNbt(head, body, staircasing, whereSupport) {
  const msg = {
    head,
    body: {
      coloursJSON, MapModes, WhereSupportBlocksModes,
      optionValue_version: VERSION,
      optionValue_staircasing: staircasing,
      optionValue_whereSupportBlocks: whereSupport,
      optionValue_supportBlock: "cobblestone",
      pixelsData: body.pixels.data,
      maps: body.maps,
      currentSelectedBlocks: body.currentSelectedBlocks,
    },
  };
  const out = runWorker("nbt.jsworker", msg);
  const wanted = head === "CREATE_MAPDAT_SPLIT" ? "MAPDAT_BYTES" : "NBT_ARRAY";
  const m = out.find((x) => x.head === wanted);
  return Buffer.from(m.body[head === "CREATE_MAPDAT_SPLIT" ? "Mapdat_Bytes" : "NBT_Array"]);
}

const SC = MapModes.SCHEMATIC_NBT.staircaseModes;
const SUP = WhereSupportBlocksModes;

const classic = runCanvas(MapModes.SCHEMATIC_NBT.uniqueId, SC.CLASSIC.uniqueId, SUP.NONE.uniqueId);
writeFileSync(`${OUT}/grid-classic.json`, JSON.stringify(gridOf(classic.pixels)));
for (const [name, sup] of [
  ["none", SUP.NONE], ["important", SUP.IMPORTANT],
  ["allopt", SUP.ALL_OPTIMIZED], ["alldouble", SUP.ALL_DOUBLE_OPTIMIZED],
]) {
  const canvasRun = runCanvas(MapModes.SCHEMATIC_NBT.uniqueId, SC.CLASSIC.uniqueId, sup.uniqueId);
  writeFileSync(`${OUT}/materials-classic-${name}.json`, JSON.stringify(materialsOf(canvasRun)));
  const nbt = runNbt("CREATE_NBT_SPLIT", canvasRun, SC.CLASSIC.uniqueId, sup.uniqueId);
  writeFileSync(`${OUT}/nbt-classic-${name}.nbt.gz`, gzipSync(nbt));
}

const flat = runCanvas(MapModes.SCHEMATIC_NBT.uniqueId, SC.OFF.uniqueId, SUP.IMPORTANT.uniqueId);
writeFileSync(`${OUT}/grid-flat.json`, JSON.stringify(gridOf(flat.pixels)));
writeFileSync(`${OUT}/materials-flat-important.json`, JSON.stringify(materialsOf(flat)));
writeFileSync(
  `${OUT}/nbt-flat-important.nbt.gz`,
  gzipSync(runNbt("CREATE_NBT_SPLIT", flat, SC.OFF.uniqueId, SUP.IMPORTANT.uniqueId)),
);

const MD = MapModes.MAPDAT.staircaseModes;
const mapdat = runCanvas(MapModes.MAPDAT.uniqueId, MD.ON_UNOBTAINABLE.uniqueId, SUP.NONE.uniqueId);
writeFileSync(`${OUT}/grid-mapdat.json`, JSON.stringify(gridOf(mapdat.pixels)));
writeFileSync(
  `${OUT}/mapdat.dat.gz`,
  gzipSync(runNbt("CREATE_MAPDAT_SPLIT", mapdat, MD.ON_UNOBTAINABLE.uniqueId, SUP.NONE.uniqueId)),
);

console.log("fixtures written");
