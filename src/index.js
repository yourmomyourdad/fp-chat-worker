
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...CORS,
    },
  });

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat</title>
<style>
  html,body{height:100%}
  body{font-family:system-ui,sans-serif;background:#16161d;color:#eee;margin:0;display:flex;flex-direction:column;height:100vh}
  #log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column}
  .m{margin:6px 0;padding:8px 10px;border-radius:10px;max-width:80%;word-wrap:break-word;white-space:pre-wrap}
  .roblox{background:#2b3a67;align-self:flex-start}
  .web{background:#6b3fa0;align-self:flex-end}
  .n{font-size:11px;opacity:.7}
  #bar{display:flex;gap:6px;padding:8px;background:#22222c}
  input{background:#33333f;color:#eee;border:0;border-radius:8px;padding:10px;font-size:16px}
  #t{flex:1;min-width:0}
  button{border:0;border-radius:8px;padding:10px 16px;background:#8a5cf5;color:#fff;font-size:16px}
  #status{padding:4px 10px;font-size:12px;color:#aaa}
</style>
</head>
<body>
<div id="log"></div>
<div id="status">Connecting...</div>
<div id="bar">
  <input id="t" placeholder="say something..." autocomplete="off">
  <button id="s">Send</button>
</div>
<script>
const name = localStorage.getItem("name") || prompt("Your name?") || "Me";
localStorage.setItem("name", name);

const log = document.getElementById("log");
const t = document.getElementById("t");
const status = document.getElementById("status");

let shown = 0;
let sending = false;

async function poll() {
  try {
    const r = await fetch("/api/poll?since=" + shown, {
      cache: "no-store"
    });

    if (!r.ok) throw new Error("Poll HTTP " + r.status);

    const data = await r.json();

    for (const m of data.messages) {
      if (m.id <= shown) continue;

      const el = document.createElement("div");
      el.className = "m " + (m.from === "roblox" ? "roblox" : "web");

      const n = document.createElement("div");
      n.className = "n";
      n.textContent = m.name;

      const x = document.createElement("div");
      x.textContent = m.text;

      el.append(n, x);
      log.append(el);
      shown = Math.max(shown, m.id);
    }

    if (data.messages.length) {
      log.scrollTop = log.scrollHeight;
    }

    status.textContent = "Connected";
  } catch (e) {
    status.textContent = "Connection error — retrying";
    console.error("Poll failed:", e);
  }
}

async function send() {
  if (sending) return;

  const text = t.value.trim();
  if (!text) return;

  sending = true;
  document.getElementById("s").disabled = true;

  try {
    const r = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", name, text })
    });

    if (!r.ok) throw new Error("Send HTTP " + r.status);

    t.value = "";
    await poll();
  } catch (e) {
    console.error("Send failed:", e);
    status.textContent = "Message failed to send";
  } finally {
    sending = false;
    document.getElementById("s").disabled = false;
    t.focus();
  }
}

document.getElementById("s").onclick = send;

t.addEventListener("keydown", e => {
  if (e.key === "Enter") send();
});

poll();
setInterval(poll, 3000);
</script>
</body>
</html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html;charset=utf-8",
          ...CORS,
        },
      });
    }

    if (!url.pathname.startsWith("/api/")) {
      return new Response("nope", { status: 404 });
    }

    const id = env.CHAT_ROOM.idFromName("main");
    const stub = env.CHAT_ROOM.get(id);

    return stub.fetch(req);
  },
};

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }

    if (url.pathname === "/api/send" && req.method === "POST") {
      let body;

      try {
        body = await req.json();

        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Invalid message");
        }
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const message = await this.ctx.storage.transaction(async txn => {
        const storedLog = await txn.get("log");
        const log = Array.isArray(storedLog) ? storedLog : [];

        const storedLatest = Number(await txn.get("latest")) || 0;
        const logLatest = log.reduce(
          (max, m) => Math.max(max, Number(m.id) || 0),
          0
        );

        const id = Math.max(storedLatest, logLatest) + 1;

        const message = {
          id,
          from: body.from === "roblox" ? "roblox" : "web",
          name: String(body.name || "").slice(0, 30),
          text: String(body.text || "").slice(0, 200),
        };

        log.push(message);

        await txn.put("log", log.slice(-100));
        await txn.put("latest", id);

        return message;
      });

      return json({ ok: true, id: message.id });
    }

    if (url.pathname === "/api/poll" && req.method === "GET") {
      const rawSince = url.searchParams.get("since");
      const parsedSince = Number(rawSince ?? 0);
      const since = Number.isFinite(parsedSince) ? parsedSince : 0;

      const result = await this.ctx.storage.transaction(async txn => {
        const storedLog = await txn.get("log");
        const log = Array.isArray(storedLog) ? storedLog : [];

        const storedLatest = Number(await txn.get("latest")) || 0;
        const logLatest = log.reduce(
          (max, m) => Math.max(max, Number(m.id) || 0),
          0
        );

        return {
          latest: Math.max(storedLatest, logLatest),
          messages: since < 0
            ? []
            : log.filter(m => m.id > since),
        };
      });

      return json(result);
    }

    return new Response("nope", {
      status: 404,
      headers: CORS,
    });
  }
}
