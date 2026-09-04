for (const b of document.querySelectorAll<HTMLButtonElement>(".copy-build")) {
  const label = b.textContent ?? "";
  b.onclick = async () => {
    const text = b.dataset.copy ?? label;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(b);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      return;
    }
    b.textContent = "copied";
    setTimeout(() => {
      b.textContent = label;
    }, 1200);
  };
}
