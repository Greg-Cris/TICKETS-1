// api/github-sync.js
// Vercel Serverless Function — roda no servidor, token nunca exposto ao browser
//
// Como configurar o token:
// 1. Vai em vercel.com → seu projeto → Settings → Environment Variables
// 2. Adiciona: GITHUB_TOKEN = (seu token ghp_...)
// 3. Redeploy

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = 'Greg-Cris/TICKETS-1';
const GITHUB_BRANCH = 'main';

const GH_HEADERS = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept':        'application/vnd.github.v3+json',
  'Content-Type':  'application/json',
};

// ═══ LÊ ARQUIVO DO GITHUB ═══
async function ghRead(path) {
  const r = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
    { headers: GH_HEADERS }
  );
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

// ═══ ESCREVE ARQUIVO NO GITHUB ═══
async function ghWrite(path, content, message, sha) {
  const payload = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) payload.sha = sha;

  const r = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    { method: 'PUT', headers: GH_HEADERS, body: JSON.stringify(payload) }
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub write ${path}: ${r.status} ${txt.slice(0, 200)}`);
  }
  return r.json();
}

// ═══ HANDLER PRINCIPAL ═══
export default async function handler(req, res) {
  // CORS — permite o site chamar essa API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // ── GET sync_status ──────────────────────────────────────
    if (req.method === 'GET' && action === 'status') {
      const { content } = await ghRead('sync_status.json');
      return res.status(200).json(content ? JSON.parse(content) : {});
    }

    // ── GET messages_db ──────────────────────────────────────
    if (req.method === 'GET' && action === 'messages') {
      const { content } = await ghRead('messages_db.json');
      return res.status(200).json(content ? JSON.parse(content) : {});
    }

    // ── POST save-batch: salva lote + confirma bot ────────────
    if (req.method === 'POST' && action === 'save-batch') {
      const { batchToken, newMessages } = req.body;

      if (!batchToken || !Array.isArray(newMessages)) {
        return res.status(400).json({ error: 'batchToken e newMessages são obrigatórios' });
      }

      // 1. Lê messages_db.json atual
      const { content: dbRaw, sha: dbSha } = await ghRead('messages_db.json');
      const allMessages = dbRaw ? JSON.parse(dbRaw) : {};

      // 2. Mescla SÓ as mensagens do lote (sem baixar tudo do Supabase)
      let added = 0;
      for (const msg of newMessages) {
        const key = `${msg.guild_id}:${msg.channel_id}`;
        if (!allMessages[key]) allMessages[key] = [];

        const existingIds = new Set(allMessages[key].map(m => m.message_id));
        if (!existingIds.has(msg.message_id)) {
          allMessages[key].push(msg);
          added++;
        } else {
          // atualiza mensagem editada
          const idx = allMessages[key].findIndex(m => m.message_id === msg.message_id);
          if (idx !== -1) allMessages[key][idx] = msg;
        }
      }

      // Ordena por timestamp
      for (const key of Object.keys(allMessages)) {
        allMessages[key].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }

      // 3. Salva messages_db.json
      await ghWrite(
        'messages_db.json',
        JSON.stringify(allMessages),
        `site: salvo lote ${batchToken} (+${added} msgs)`,
        dbSha
      );

      // 4. Confirma lote no sync_status.json
      const { content: statusRaw, sha: statusSha } = await ghRead('sync_status.json');
      const status = statusRaw ? JSON.parse(statusRaw) : {};
      status.confirmed_token = batchToken;
      status.confirmed_at    = new Date().toISOString();
      status.confirmed_count = added;

      await ghWrite(
        'sync_status.json',
        JSON.stringify(status, null, 2),
        `site: confirmado lote ${batchToken}`,
        statusSha
      );

      return res.status(200).json({ ok: true, added, total: newMessages.length });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error('[github-sync]', e);
    return res.status(500).json({ error: e.message });
  }
}
