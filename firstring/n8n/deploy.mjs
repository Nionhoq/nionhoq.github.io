// Upsert + activate the FirstRing workflows through the n8n public API (X-N8N-API-KEY).
// The error workflow is deployed first so the others can point at its id.
import { buildWorkflows } from "./build.mjs";

export async function deployWorkflows({ apiUrl, apiKey, clients, fetchImpl = fetch, log = () => {} }) {
  const api = async (method, path, body) => {
    const res = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/api/v1${path}`, {
      method, headers: { "X-N8N-API-KEY": apiKey, "content-type": "application/json", accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`n8n ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const existing = new Map();
  let cursor;
  do {
    const page = await api("GET", `/workflows?limit=250${cursor ? `&cursor=${cursor}` : ""}`);
    for (const w of page.data) if (w.name.startsWith("firstring-")) existing.set(w.name, w.id);
    cursor = page.nextCursor;
  } while (cursor);

  const upsert = async (wf) => {
    const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
    let id = existing.get(wf.name);
    if (id) await api("PUT", `/workflows/${id}`, body);
    else id = (await api("POST", "/workflows", body)).id;
    await api("POST", `/workflows/${id}/activate`);
    log(`${existing.has(wf.name) ? "updated" : "created"} ${wf.name} (${id})`);
    existing.set(wf.name, id);
    return id;
  };

  const [errorsWf] = await buildWorkflows(clients);
  const errorId = await upsert(errorsWf);
  const all = await buildWorkflows(clients, { errorWorkflowId: errorId });
  const ids = { [errorsWf.name]: errorId };
  for (const wf of all.slice(1)) ids[wf.name] = await upsert(wf);
  return ids;
}
