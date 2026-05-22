// Tiny popup: shows whether the local NanoClaw queue is reachable.

(async () => {
  const statusEl = document.getElementById('status');
  const hintEl = document.getElementById('hint');
  try {
    const res = await fetch('http://localhost:7733/queue', { method: 'GET' });
    if (res.ok) {
      const items = await res.json();
      statusEl.textContent = `Connected ✓ (${items.length} pending)`;
      statusEl.className = 'status ok';
      hintEl.textContent = 'NanoClaw is reachable. Place saves will land in your Saved Places lists.';
    } else {
      statusEl.textContent = `Reachable but errored (${res.status})`;
      statusEl.className = 'status down';
    }
  } catch (e) {
    statusEl.textContent = 'NanoClaw queue down';
    statusEl.className = 'status down';
    hintEl.textContent = 'Is NanoClaw running on this Mac? Restart it via launchctl kickstart.';
  }
})();
