import init, { Session } from "./wasm-pkg/arachne_wasm.js";
import wasmUrl from "./wasm-pkg/arachne_wasm_bg.wasm?url";
import type { WorkerRequest, WorkerResponse } from "./types";

let session: Session | null = null;

function reply(msg: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    switch (req.cmd) {
      case "init": {
        await init(wasmUrl);
        const res = await fetch(`${import.meta.env.BASE_URL}blocks-26.2.json`);
        if (!res.ok) throw new Error(`blocks data: HTTP ${res.status}`);
        session = new Session(await res.text());
        reply({
          id: req.id,
          ok: true,
          result: {
            colors: JSON.parse(session.colors()),
            blocks: JSON.parse(session.blocks()),
            dataVersion: session.data_version(),
            versions: JSON.parse(session.versions()),
            tools: JSON.parse(session.tool_meta()),
            tiers: JSON.parse(session.tier_meta()),
          },
        });
        break;
      }
      case "generate": {
        const s = must();
        let last = -1;
        const out = s.generate(
          new Uint8Array(req.rgba),
          req.width,
          req.height,
          JSON.stringify(req.opts),
          (f: number) => {
            const pct = Math.round(f * 100);
            if (pct !== last) {
              last = pct;
              reply({ id: req.id, progress: f });
            }
          },
        );
        reply({ id: req.id, ok: true, result: JSON.parse(out) });
        break;
      }
      case "preview": {
        const bytes = must().preview_rgba();
        reply({ id: req.id, ok: true, result: bytes.buffer }, [bytes.buffer]);
        break;
      }
      case "mapdat": {
        const bytes = must().export_mapdat(req.tx, req.tz, req.version);
        reply({ id: req.id, ok: true, result: bytes.buffer }, [bytes.buffer]);
        break;
      }
      case "schem_split": {
        const s = must();
        const out = s.export_schem_split(JSON.stringify(req.opts));
        reply({ id: req.id, ok: true, result: out.buffer }, [out.buffer]);
        break;
      }
      case "view": {
        const out = must().view(JSON.stringify(req.opts), req.panel);
        reply({ id: req.id, ok: true, result: JSON.parse(out) });
        break;
      }
      case "share_code": {
        reply({ id: req.id, ok: true, result: must().share_code(JSON.stringify(req.palette)) });
        break;
      }
      case "read_share_code": {
        reply({ id: req.id, ok: true, result: JSON.parse(must().read_share_code(req.code)) });
        break;
      }
      case "materials_split": {
        reply({ id: req.id, ok: true, result: JSON.parse(must().materials_split()) });
        break;
      }
      case "support_totals": {
        const out = must().support_totals(JSON.stringify(req.opts));
        reply({ id: req.id, ok: true, result: JSON.parse(out) });
        break;
      }
      case "schem": {
        const bytes = must().export_schem(JSON.stringify(req.opts));
        reply({ id: req.id, ok: true, result: bytes.buffer }, [bytes.buffer]);
        break;
      }
      case "rank": {
        const out = must().rank(
          req.colorId,
          JSON.stringify(req.loadout),
          JSON.stringify(req.config),
        );
        reply({ id: req.id, ok: true, result: JSON.parse(out) });
        break;
      }
      case "audit": {
        const out = must().audit(JSON.stringify(req.loadout), JSON.stringify(req.config));
        reply({ id: req.id, ok: true, result: JSON.parse(out) });
        break;
      }
      case "marginal": {
        const out = must().marginal(JSON.stringify(req.enabled), JSON.stringify(req.tones));
        reply({ id: req.id, ok: true, result: JSON.parse(out) });
        break;
      }
    }
  } catch (e) {
    reply({ id: req.id, ok: false, error: String(e) });
  }
};

function must(): Session {
  if (!session) throw new Error("worker not initialized");
  return session;
}
