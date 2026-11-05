# ZombieCoder Universal Transport Adapter

**একটি প্রসেস · তিনটি ট্রান্সপোর্ট · একটাই MCP টুল রেজিস্ট্রি**

Claude Desktop, Cursor, VS Code, OpenCode, Zed, Windsurf, Continue — সবাই
আলাদা আলাদা protocol চায়। এই অ্যাডাপ্টার সবাইকে **একটাই প্রক্রিয়া** থেকে সামলায়।

---

## চালু করা

```bash
cd universal-adapter

node index.js                # HTTP + HTTPS + TLS + ক্লায়েন্ট স্ক্যান
node index.js --stdio        # stdio শুধু (ডেস্কটপ ক্লায়েন্ট যেভাবে spawn করে)
node index.js --scan         # ক্লায়েন্ট কনফিগ খুঁজে দেখে (কিছু বদলায় না)
node index.js --register     # ক্লায়েন্ট কনফিগে লিখে দেয় (ব্যাকআপ সহ)
node index.js --verify       # সব transport যাচাই + রিপোর্ট
```

---

## তিনটি ট্রান্সপোর্ট

| ট্রান্সপোর্ট | ঠিকানা | কে ব্যবহার করে |
|-------------|--------|---------------|
| **HTTP** | `http://127.0.0.1:5400/mcp` | লোকাল ক্লায়েন্ট, curl, স্ক্রিপ্ট |
| **HTTPS** | `https://localhost:5443/mcp` | দূর থেকে, টানেল, TLS প্রয়োজনে |
| **stdio** | `node index.js --stdio` | Claude Desktop, Cursor (সাবপ্রোসেস) |

তিনটাই **একই রেজিস্ট্রি** থেকে টুল দেয় — কোনো transport-এ কম-বেশি নেই।

### HTTP সার্ভার ৪ভাবে উত্তর দেয়

কারণ ভিন্ন ক্লায়েন্ট ভিন্ন path বেছে নেয়:

| পদ্ধতি | পথ | কে ব্যবহার করে |
|--------|-----|---------------|
| `POST` | `/mcp` | বেশিরভাগ আধুনিক ক্লায়েন্ট |
| `POST` (SSE চাইলে) | `/mcp` | streamable-http ক্লায়েন্ট |
| `GET` | `/mcp` | SSE স্ট্রিম খোলে রাখে |
| `ANY` | `/sse` | পুরোনো MCP ক্লায়েন্ট |

---

## TLS

| বিষয় | মান |
|-------|-----|
| প্রটোকল | **TLS 1.3** |
| সাইফার | `TLS_AES_256_GCM_SHA384` |
| সার্টিফিকেট | সেলফ-সাইনড, ৯০ দিন বৈধ |
| ফাইল | `~/.zombiecoder/certs/adapter-cert.pem` |
| প্রাইভেট কী | `~/.zombiecoder/certs/adapter-key.pem` (`chmod 600`) |
| ইস্যুয়ার | `C=BD, ST=Barisal, L=Dhaka, O=ZombieCoder` |

openssl CLI ব্যবহার করে তৈরি — কোনো npm নির্ভরতা নেই, ইন্টারনেট লাগে না।

সার্টিফিকেট **স্বয়ংক্রিয়ভাবে** পুনরায় বানানো হয়, যখন:
- ফাইল নেই
- ২৪ ঘণ্টার মধ্যে মেয়াদ শেষ হবে
- hostname বদলেছে

---

## টুল (১৫৫টি)

অ্যাডাপ্টার **নিজের ১০টা** + **মেইন সার্ভার থেকে টানা ১৫২টা** = ১৬২ র
(৭টা কলিডিং বাদ দিয়ে প্রকাশিত **১৫৫টা**)।

### নিজের ১০টা (এখানেই লেখা, স্যান্ডবক্সসহ)

| টুল | কাজ |
|-----|------|
| `adapter_status` | ট্রান্সপোর্ট, টুল ও মেইন সার্ভার লিংকের অবস্থা |
| `system_info` | OS, Node, CPU, মেমরি |
| `list_directory` | ডিরেক্টরি লিস্ট (recursive সহ) |
| `read_file` | টেক্সট ফাইল পড়া |
| `write_file` | টেক্সট ফাইল লেখা |
| `delete_file` | ফাইল মুছা |
| `glob` | প্যাটার্ন দিয়ে ফাইল খোঁজা |
| `grep` | কনটেন্টে রেগুলার এক্সপ্রেশন সার্চ |
| `hash_text` | sha256 হ্যাশ |
| `agent_personas` | এজেন্ট পার্সোনা ও সংবিধান (`personas.js`): পরিচয়, শেয়ার্ড রুল, প্রিন্সিপল, ৬ এজেন্টের রোস্টার — `Args: { id?, section? }` |

### মেইন সার্ভার থেকে টানা ১৫২টা (Pull Sync)

`main-sync.js` মেইন সার্ভারের `tools/list` **টেনে** নেয় (প্রতি ৩০ সেকেন্ডে),
আর `tools/call` হলে সরাসরি মেইন সার্ভারে ফরওয়ার্ড করে। মেইন সার্ভারে
(`api.js`) কোনো পরিবর্তন করতে হয় না।

```
মেইন সার্ভার (5050, ১৫২ টুল)
      ↓ pull (৩০s TTL)
অ্যাডাপ্টার (১০ নিজের + ১৫২ রিমোট − ৭ কলিডিং = ১৫৫)
      ↓ তিনটে transport (HTTP / HTTPS / stdio)
ক্লায়েন্ট
```

| বিষয় | মান |
|-------|-----|
| সোর্স | `http://127.0.0.1:5050/mcp` (env: `MAIN_SERVER_MCP`) |
| TTL | ৩০ সেকেন্ড (env: `MAIN_SYNC_TTL_MS`) |
| টাইমআউট | ২০ সেকেন্ড (env: `MAIN_SYNC_TIMEOUT_MS`) |
| কলিডিং | ৭টা নাম মিলে — **অ্যাডাপ্টারের স্যান্ডবক্সড ভার্সন জেতে** |
| মেইন সার্ভার ডাউন | নিজের ১০টা দেয়, ব্রেক হয় না |

কলিডিং ৭টা: `system_info`, `list_directory`, `read_file`, `write_file`,
`delete_file`, `glob`, `grep`। মেইন সার্ভারের `read_file` কোনো রুট ছোঁয় না
(`/etc/passwd` পড়ে), আর HTTPS ট্রান্সপোর্ট `0.0.0.0`-এ বাইন্ড হয় — তাই
লোকাল সংস্করণই জিতে, রিমোটটা কখনো শ্যাডো করে না।

### নিরাপত্তা — স্যান্ডবক্স

ফাইল টুলগুলো **root বাইরে যেতে পারে না**। বাইরে গেলে ত্রুটি:

```json
{ "error": "path outside allowed roots: /etc/passwd",
  "allowedRoots": ["/path/to/zombiebd/universal-adapter"] }
```

root বদলাতে:

```bash
ADAPTER_ROOTS="/path/to/zombiebd,/path/to/docs" node index.js
```

---

## টেস্ট

```bash
node index.js --verify                     # 3 টেস্ট (EXIT কোড ফেরত দেয়)
```

চালানোর আগে অ্যাডাপ্টার চালু থাকা লাগবে (`node index.js`),
কারণ টেস্টটা আসল ব্যাকএন্ডের বিরুদ্ধে চলে।

বর্তমান অবস্থা: **অ্যাডাপ্টার ৩/৩**

---

## ফাইল

```
universal-adapter/
├── index.js              মূল — তিন transport চালায়
├── registry.js           একটাই MCP টুল রেজিস্ট্রি + JSON-RPC
├── main-sync.js          মেইন সার্ভার থেকে টুল টানে (Pull Sync)
├── transport-http.js     HTTP + HTTPS (একই হ্যান্ডলার)
├── transport-stdio.js    stdio (stdout শুধু প্রোটোকলের জন্য)
├── tls.js                সেলফ-সাইনড সার্টিফিকেট
└── discover.js           ক্লায়েন্ট শোধা + অটো-রেজিস্ট্রেশন
```

---

## ইন্টিগ্রেশন অবস্থা

| ক্লায়েন্ট | ফাইল | অবস্থা |
|----------|------|--------|
| OpenCode (MCP) | `~/.opencode/opencode.json` → `mcp` | `zombie-universal` (HTTPS, ১৫২ টুল) |
| VS Code | `~/.config/Code/User/mcp.json` | `zombie-universal` (stdio) |
| Claude Desktop | — | ফাইল নেই |
| Cursor | — | ফাইল নেই |
| Zed / Windsurf / Continue | — | ফাইল নেই |

সব কনফিগ লেখার আগে `.bak-<timestamp>` ব্যাকআপ তৈরি হয়।

---

**তৈরি:** ZombieCoder Dev Agent · Sahon Srabon · Developer Zone · Dhaka, Bangladesh