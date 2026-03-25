// api/github-sync.js
// API Vercel — processa lotes do Supabase e salva no GitHub

import { Octokit } from "@octokit/rest";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service key (server-side)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;   // ex: "Greg-Cris"
const GITHUB_REPO  = process.env.GITHUB_REPO;    // ex: "TICKETS-1"
const GITHUB_FILE  = "messages_db.json";          // arquivo no repositório

const SB_HDR = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
};

// ═══════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;

  try {
    // ── GET /api/github-sync?action=messages ──
    // Retorna o messages_db.json do GitHub pro site exibir
    if (req.method === "GET" && action === "messages") {
      const db = await loadMessagesDb();
      return res.status(200).json(db);
    }

    // ── GET /api/github-sync?action=pending ──
    // Retorna quantos lotes pendentes existem no Supabase
    if (req.method === "GET" && action === "pending") {
      const batches = await fetchPendingBatches();
      return res.status(200).json({ count: batches.length, batches: batches.map(b => b.batch_token) });
    }

    // ── POST /api/github-sync?action=process ──
    // Processa TODOS os lotes pendentes do Supabase
    if (req.method === "POST" && action === "process") {
      const result = await processAllBatches();
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Ação inválida. Use: messages, pending, process" });

  } catch (err) {
    console.error("Erro na API:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════
//  BUSCA LOTES PENDENTES NO SUPABASE
// ═══════════════════════════════════════════════════

async function fetchPendingBatches() {
  const url = `${SUPABASE_URL}/rest/v1/batches?select=batch_token,data,created_at&order=created_at.asc`;
  const r = await fetch(url, { headers: SB_HDR });
  if (!r.ok) throw new Error(`Supabase fetchBatches: ${r.status}`);
  return await r.json();
}

// ═══════════════════════════════════════════════════
//  APAGA LOTE DO SUPABASE
// ═══════════════════════════════════════════════════

async function deleteBatch(batchToken) {
  const url = `${SUPABASE_URL}/rest/v1/batches?batch_token=eq.${encodeURIComponent(batchToken)}`;
  const r = await fetch(url, { method: "DELETE", headers: SB_HDR });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase deleteBatch: ${r.status} — ${text}`);
  }
}

// ═══════════════════════════════════════════════════
//  CARREGA messages_db.json DO GITHUB
// ═══════════════════════════════════════════════════

async function loadMessagesDb() {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      path:  GITHUB_FILE,
    });
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(content);
  } catch (e) {
    if (e.status === 404) return {}; // arquivo ainda não existe
    throw e;
  }
}

// ═══════════════════════════════════════════════════
//  SALVA messages_db.json NO GITHUB
// ═══════════════════════════════════════════════════

async function saveMessagesDb(db) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  // Pega o SHA atual (necessário para update)
  let sha = undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      path:  GITHUB_FILE,
    });
    sha = data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const content = Buffer.from(JSON.stringify(db), "utf-8").toString("base64");
  const payload = {
    owner:   GITHUB_OWNER,
    repo:    GITHUB_REPO,
    path:    GITHUB_FILE,
    message: `bot: atualiza mensagens — ${new Date().toISOString()}`,
    content,
    branch:  "main",
  };
  if (sha) payload.sha = sha;

  await octokit.repos.createOrUpdateFileContents(payload);
}

// ═══════════════════════════════════════════════════
//  PROCESSA TODOS OS LOTES
// ═══════════════════════════════════════════════════

async function processAllBatches() {
  const batches = await fetchPendingBatches();

  if (batches.length === 0) {
    return { processed: 0, added: 0, message: "Nenhum lote pendente" };
  }

  // Carrega o DB atual do GitHub
  const db = await loadMessagesDb();

  let totalAdded = 0;

  for (const batch of batches) {
    const msgs = Array.isArray(batch.data) ? batch.data : [];

    // Mescla mensagens no DB
    for (const msg of msgs) {
      const key = `${msg.guild_id}:${msg.channel_id}`;
      if (!db[key]) db[key] = [];

      const ids = new Set(db[key].map(m => m.message_id));
      if (!ids.has(msg.message_id)) {
        db[key].push(msg);
        totalAdded++;
      } else {
        // Atualiza mensagem existente (edições)
        const idx = db[key].findIndex(m => m.message_id === msg.message_id);
        if (idx !== -1) db[key][idx] = msg;
      }
    }

    // Ordena por timestamp
    for (const key of Object.keys(db)) {
      db[key].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    // Salva no GitHub
    await saveMessagesDb(db);

    // Apaga o lote do Supabase — bot vai perceber e mandar mais
    await deleteBatch(batch.batch_token);

    console.log(`✅ Lote ${batch.batch_token} processado — ${msgs.length} msgs`);
  }

  return {
    processed: batches.length,
    added:     totalAdded,
    message:   `${batches.length} lote(s) processado(s), ${totalAdded} mensagens novas`,
  };
}
