
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
.m{margin:6px 0;padding:8px 10px;border-radius:10px;max-width:80%;word-wrap:break-word}
.roblox{background:#2b3a67;align-self:flex-start}
.web{background:#6b3fa0;align-self:flex-end}
.n{font-size:11px;opacity:.7}
#bar{display:flex;gap:6px;padding:8px;background:#22222c}
input{background:#33333f;color:#eee;border:0;border-radius:8px;padding:10px;font-size:16px}
#t{flex:1}
button{border:0;border-radius:8px;padding:10px 16px;background:#8a5cf5;color:#fff;font-size:16px}
</style>
</head>
<body>
<div id="log"></div>
<div id="bar">
<input id="t" placeholder="say something..." autocomplete="off">
<button id="s">Send</button>
</div>
<script>
let name = localStorage.getItem("name") || prompt("Your name?") || "Me";
localStorage.setItem("name", name);

const log = document.getElementById("log");
const t = document.getElementById("t");
let shown = 0;

async function poll() {
  try {
    const r = await fetch("/api/poll?since=0", {
      cache: "no-store"
    });
    if (!r.ok) throw new Error("Poll failed: " + r.status);

    const d = await r.json();

    for (const m of d.messages.filter(m => m.id > shown)) {
      const el = document.createElement("div");
      el.className = "m " + m.from;

      const n = document.createElement("div");
      n.className = "n";
      n.textContent = m.name;

      const x = document.createElement("div");
      x.textContent = m.text;

      el.append(n, x);
      log.append(el);
      shown = m.id;
    }

    if (d.messages.some(m => m.id === shown)) {
      log.scrollTop = log.scrollHeight;
    }
  } catch (e) {
    console.error(e);
  }
}

async function send() {
  const text = t.value.trim();
  if (!text) return;

  t.value = "";

  try {
    const r = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", name, text })
    });

    if (!r.ok) throw new Error("Send failed: " + r.status);
    await poll();
  } catch (e) {
    console.error(e);
    alert("Message failed to send. Please try again.");
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
        headers: CORS
      });
    }

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html;charset=utf-8"
        }
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
    this.env = env;
  }

  async ensureInitialized() {
    if (await this.ctx.storage.get("initialized")) {
      return;
    }

    let oldLog = [];

    // Import the old KV message history once.
    if (this.env.CHAT) {
      const raw = await this.env.CHAT.get("log");

      if (raw) {
        try {
          const parsed = JSON.parse(raw);

          if (Array.isArray(parsed)) {
            oldLog = parsed
              .filter(m => m && Number.isFinite(Number(m.id)))
              .slice(-100)
              .map(m => ({
                id: Number(m.id),
                from: m.from === "roblox" ? "roblox" : "web",
                name: String(m.name || "").slice(0, 30),
                text: String(m.text || "").slice(0, 200),
              }));
          }
        } catch {
          oldLog = [];
        }
      }
    }

    await this.ctx.storage.transaction(async txn => {
      if (await txn.get("initialized")) return;

      await txn.put("log", oldLog);
      await txn.put("initialized", true);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
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

      await this.ensureInitialized();

      const message = await this.ctx.storage.transaction(async txn => {
        const log = (await txn.get("log")) || [];
        const latest = log.reduce(
          (max, m) => Math.max(max, Number(m.id) || 0),
          0
        );

        const message = {
          id: latest + 1,
          from: body.from === "roblox" ? "roblox" : "web",
          name: String(body.name || "").slice(0, 30),
          text: String(body.text || "").slice(0, 200),
        };

        log.push(message);
        await txn.put("log", log.slice(-100));

        return message;
      });

      return json({ ok: true, id: message.id });
    }

    if (url.pathname === "/api/poll" && req.method === "GET") {
      await this.ensureInitialized();

      const log = (await this.ctx.storage.get("log")) || [];
      const latest = log.reduce(
        (max, m) => Math.max(max, Number(m.id) || 0),
        0
      );

      const rawSince = url.searchParams.get("since");
      const parsedSince = Number(rawSince ?? 0);
      const since = Number.isFinite(parsedSince) ? parsedSince : 0;

      return json({
        latest,
        messages: since < 0
          ? []
          : log.filter(m => m.id > since),
      });
    }

    return new Response("nope", {
      status: 404,
      headers: CORS,
    });
  }
}
