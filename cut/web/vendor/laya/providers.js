function toNested(data, dims) {
    const flat = Array.from(data, (v)=>typeof v === "bigint" ? Number(v) : v);
    if (dims.length === 0) return flat[0];
    const rec = (d, off)=>{
        if (d === dims.length - 1) return flat.slice(off, off + dims[d]);
        const step = dims.slice(d + 1).reduce((a, b)=>a * b, 1);
        const out = [];
        for(let i = 0; i < dims[d]; i++)out.push(rec(d + 1, off + i * step));
        return out;
    };
    return rec(0, 0);
}
function i64(ort, arr, dims) {
    const flat = arr.flat(Infinity).map((v)=>BigInt(Math.trunc(v)));
    return new ort.Tensor("int64", BigInt64Array.from(flat), dims);
}
export function feed(ort, b) {
    const n = b.inputIds.length;
    const L = Math.max(1, ...b.inputIds.map((r)=>r.length));
    return {
        input_ids: i64(ort, b.inputIds, [
            n,
            L
        ]),
        attention_mask: i64(ort, b.attentionMask, [
            n,
            L
        ])
    };
}
export function feedHead(ort, hidden, b) {
    const n = b.markerPos.length;
    const k = Math.max(1, ...b.markerPos.map((r)=>r.length));
    // Patched for cut: the web provider hands over the encoder's tensor directly (see createWebProvider).
    const isTensor = hidden instanceof ort.Tensor;
    const H = isTensor ? hidden : new ort.Tensor("float32", Float32Array.from(hidden.flat(Infinity).map(Number)), [
        hidden.length ?? n,
        hidden[0]?.length ?? 1,
        hidden[0]?.[0]?.length ?? 1
    ]);
    const S = isTensor ? hidden.dims[1] : hidden[0]?.length ?? 1;
    const maskRows = b.attentionMask.map((r)=>{
        const row = r.slice(0, S);
        while(row.length < S)row.push(0);
        return row;
    });
    return {
        hidden_states: H,
        marker_pos: i64(ort, b.markerPos, [
            n,
            k
        ]),
        marker_mask: new ort.Tensor("bool", Uint8Array.from(b.markerMask.flat(Infinity).map((v)=>v ? 1 : 0)), [
            n,
            k
        ]),
        qtype: i64(ort, b.qtype.map((v)=>[
                v
            ]), [
            n,
            1
        ]),
        attention_mask: i64(ort, maskRows, [
            n,
            S
        ])
    };
}
function pickOutput(out, names) {
    for (const n of names)if (out[n] !== undefined) return out[n];
    const vals = Object.values(out);
    return vals[0];
}
function applyNumThreads(ort, numThreads) {
    try {
        const raw = numThreads ?? (typeof process !== "undefined" ? Number(process.env?.["LAYA_THREADS"]) : NaN);
        if (Number.isFinite(raw) && raw > 0 && ort?.env) {
            ort.env.numThreads = Math.trunc(raw);
        }
    } catch  {}
}
function isOomError(e) {
    const m = String(e?.message ?? e).toLowerCase();
    return m.includes("memory") || m.includes("cuda") || m.includes("out of memory") || m.includes("oom");
}
// Patched for cut: the stock version always went to the network (the cache was only an offline
// fallback), so every visit re-downloaded the model. This one is cache-first, reports progress, and
// downloads big files as parallel HTTP Range chunks: a single 500 MB stream from the Hugging Face CDN
// can drop partway (ERR_HTTP2_PROTOCOL_ERROR), and one connection there runs at a few MB/s.
let onFetchProgress = null;
export function setFetchProgress(fn) {
    onFetchProgress = fn;
}
const CHUNK = 16 << 20;
const PARALLEL = 6;
const TRIES = 5;
const CHUNK_TIMEOUT_MS = 60000; // a stalled connection is retried rather than waited on
async function fetchArrayBuffer(url) {
    let cache = null;
    try {
        cache = await globalThis.caches?.open("laya-ts") ?? null;
    } catch  {
        cache = null;
    }
    if (cache) {
        try {
            const hit = await cache.match(url);
            if (hit) return await hit.arrayBuffer();
        } catch  {}
    }
    const buf = await download(url);
    if (cache) {
        try {
            await cache.put(url, new Response(buf));
        } catch  {}
    }
    return buf;
}
async function download(url) {
    // The first chunk doubles as the probe: a 206 tells us the total size from Content-Range.
    const first = await withRetries(()=>fetch(url, {
            headers: {
                Range: `bytes=0-${CHUNK - 1}`
            }
        }));
    if (!first.ok) throw new Error(`fetch failed for ${url}: ${first.status}`);
    const total = Number(first.headers.get("content-range")?.split("/")[1]);
    if (first.status !== 206 || !total) return await readAll(first, url, Number(first.headers.get("content-length")) || 0);
    const out = new Uint8Array(total);
    let got = 0;
    const report = (n)=>{
        got += n;
        onFetchProgress?.(url, got, total);
    };
    out.set(new Uint8Array(await first.arrayBuffer()), 0);
    report(Math.min(CHUNK, total));
    const ranges = [];
    for(let start = CHUNK; start < total; start += CHUNK)ranges.push([
        start,
        Math.min(total, start + CHUNK) - 1
    ]);
    let next = 0;
    const worker = async ()=>{
        while(next < ranges.length){
            const [a, b] = ranges[next++];
            const piece = await withRetries(async ()=>{
                const res = await fetch(url, {
                    headers: {
                        Range: `bytes=${a}-${b}`
                    },
                    signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS)
                });
                if (res.status !== 206) throw new Error(`fetch failed for ${url}: ${res.status}`);
                const body = new Uint8Array(await res.arrayBuffer());
                if (body.length !== b - a + 1) throw new Error(`short read for ${url}`);
                return body;
            });
            out.set(piece, a);
            report(piece.length);
        }
    };
    await Promise.all(Array.from({
        length: PARALLEL
    }, worker));
    return out.buffer;
}
async function withRetries(fn) {
    for(let attempt = 1;; attempt++){
        try {
            return await fn();
        } catch (e) {
            if (attempt >= TRIES) throw e;
            await new Promise((r)=>setTimeout(r, 400 * 2 ** attempt));
        }
    }
}
async function readAll(res, url, total) {
    if (!res.body || !onFetchProgress) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for(;;){
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onFetchProgress(url, got, total);
    }
    const joined = new Uint8Array(got);
    let o = 0;
    for (const c of chunks){
        joined.set(c, o);
        o += c.length;
    }
    return joined.buffer;
}
async function fetchJson(url) {
    const buf = await fetchArrayBuffer(url);
    return JSON.parse(new TextDecoder().decode(buf));
}
export async function loadNodeBundle(modelDirOrRepo, opts) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const sub = opts?.subfolder ?? null;
    let dir = opts?.localDir ?? modelDirOrRepo;
    try {
        const st = await fs.stat(sub ? path.join(dir, sub) : dir);
        if (st.isDirectory()) dir = sub ? path.join(dir, sub) : dir;
        else dir = path.dirname(dir);
    } catch  {
        const cache = path.join(os.homedir(), ".cache", "laya-ts", "hf", modelDirOrRepo.replace(/\//g, "__"), sub ?? "root");
        await fs.mkdir(cache, {
            recursive: true
        });
        const token = opts?.token ?? (typeof process !== "undefined" ? process.env?.["HF_TOKEN"] : undefined);
        for (const f of [
            "rl_agent_config.json",
            "tokenizer.json",
            "tokenizer/tokenizer.json",
            "encoder.onnx",
            "head.onnx"
        ]){
            try {
                await fs.stat(path.join(cache, f));
            } catch  {
                const url = `https://huggingface.co/${modelDirOrRepo}/resolve/main/${sub ? sub + "/" : ""}${f}`;
                const res = await fetch(url, token ? {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                } : undefined);
                if (!res.ok) {
                    if (f === "rl_agent_config.json") {
                        throw new Error(`Incompatible model: ${JSON.stringify(modelDirOrRepo)} does not contain 'rl_agent_config.json'.`);
                    }
                    continue;
                }
                const target = path.join(cache, f);
                await fs.mkdir(path.dirname(target), {
                    recursive: true
                });
                await fs.writeFile(target, new Uint8Array(await res.arrayBuffer()));
            }
        }
        dir = cache;
    }
    let cfg = {};
    try {
        cfg = JSON.parse(await fs.readFile(path.join(dir, "rl_agent_config.json"), "utf8"));
    } catch  {
        throw new Error(`Incompatible model: ${JSON.stringify(modelDirOrRepo)} does not contain 'rl_agent_config.json'.`);
    }
    let tokenizerJson = null;
    for (const candidate of [
        "tokenizer.json",
        "tokenizer/tokenizer.json"
    ]){
        try {
            tokenizerJson = JSON.parse(await fs.readFile(path.join(dir, candidate), "utf8"));
            break;
        } catch  {}
    }
    return {
        dir,
        cfg,
        tokenizerJson
    };
}
function baseUrlFor(repoOrUrl, subfolder) {
    const sub = subfolder ? `/${subfolder.replace(/^\/+|\/+$/g, "")}` : "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repoOrUrl)) {
        return `${repoOrUrl.replace(/\/+$/, "")}${sub}`;
    }
    return `https://huggingface.co/${repoOrUrl}/resolve/main${sub}`;
}
export async function loadWebBundle(repoOrUrl, opts) {
    const base = baseUrlFor(repoOrUrl, opts?.subfolder ?? null);
    let cfg;
    try {
        cfg = await fetchJson(`${base}/rl_agent_config.json`);
    } catch  {
        throw new Error(`Incompatible model: ${JSON.stringify(repoOrUrl)} does not contain 'rl_agent_config.json'.`);
    }
    let tokenizerJson = null;
    for (const candidate of [
        "tokenizer.json",
        "tokenizer/tokenizer.json"
    ]){
        try {
            tokenizerJson = await fetchJson(`${base}/${candidate}`);
            break;
        } catch  {}
    }
    return {
        dir: base,
        cfg,
        tokenizerJson
    };
}
export async function createNodeProvider(modelDir, opts) {
    const spec = "onnxruntime-" + "node";
    const ort = await import(spec);
    applyNumThreads(ort, opts?.numThreads);
    try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        for (const f of [
            "encoder.onnx",
            "head.onnx"
        ]){
            const p = path.join(modelDir, f);
            try {
                await fs.stat(p);
            } catch  {
                throw new Error(`Incompatible model: '${f}' not found in ${JSON.stringify(modelDir)} (expected ${p}).`);
            }
        }
    } catch (e) {
        if (e instanceof Error && e.message.includes("not found in")) throw e;
    }
    const dev = String(opts?.device ?? "cpu").toLowerCase();
    const want = dev === "cuda" ? "cuda" : dev === "dml" ? "dml" : "cpu";
    const make = async (ep)=>{
        const e = await ort.InferenceSession.create(`${modelDir}/encoder.onnx`, {
            executionProviders: [
                ep
            ]
        });
        const h = await ort.InferenceSession.create(`${modelDir}/head.onnx`, {
            executionProviders: [
                "cpu"
            ]
        });
        return {
            e,
            h
        };
    };
    let enc;
    let head;
    let activeEP = want;
    try {
        ({ e: enc, h: head } = await make(want));
    } catch (e) {
        if (want !== "cpu") {
            console.warn(`Warning: ${want.toUpperCase()} requested but not available. Falling back to CPU.`);
            ({ e: enc, h: head } = await make("cpu"));
            activeEP = "cpu";
        } else {
            throw e;
        }
    }
    let cpuEnc = null;
    let cpuHead = null;
    const ensureCpu = async ()=>{
        if (!cpuEnc) {
            cpuEnc = await ort.InferenceSession.create(`${modelDir}/encoder.onnx`, {
                executionProviders: [
                    "cpu"
                ]
            });
            cpuHead = await ort.InferenceSession.create(`${modelDir}/head.onnx`, {
                executionProviders: [
                    "cpu"
                ]
            });
        }
        return {
            cpuEnc,
            cpuHead
        };
    };
    const runWithCpuFallback = async (fn)=>{
        try {
            return await fn(enc, head);
        } catch (e) {
            if (activeEP !== "cpu" && isOomError(e)) {
                console.warn("Warning: GPU memory exceeded during inference. Falling back to CPU...");
                const { cpuEnc: ce, cpuHead: ch } = await ensureCpu();
                enc = ce;
                head = ch;
                activeEP = "cpu";
                return await fn(enc, head);
            }
            if (isOomError(e)) {
                throw new Error(`${e.message} (GPU out of memory; try device: "cpu")`);
            }
            throw e;
        }
    };
    return {
        runEncoder: async (b)=>runWithCpuFallback(async (e)=>{
                const out = await e.run(feed(ort, b));
                const t = pickOutput(out, [
                    "last_hidden_state",
                    "lastHidden",
                    "hidden_states"
                ]);
                return {
                    lastHidden: toNested(t.data, t.dims)
                };
            }),
        runHead: async (h, b)=>runWithCpuFallback(async (_e, hd)=>{
                const out = await hd.run(feedHead(ort, h, b));
                const vals = Object.values(out);
                const lt = pickOutput(out, [
                    "logits"
                ]);
                const at = pickOutput(out, [
                    "act_logits",
                    "act"
                ]) ?? vals[1] ?? vals[0];
                return {
                    logits: toNested(lt.data, lt.dims),
                    act: toNested(at.data, at.dims)
                };
            })
    };
}
export async function createWebProvider(modelUrl, opts) {
    const spec = "onnxruntime-" + "web";
    const ort = await import(spec);
    applyNumThreads(ort, opts?.numThreads);
    const base = modelUrl.replace(/\/+$/, "");
    const encUrl = `${base}/encoder.onnx`;
    const headUrl = `${base}/head.onnx`;
    let encBuf;
    try {
        encBuf = await fetchArrayBuffer(encUrl);
    } catch  {
        throw new Error(`Incompatible model: 'encoder.onnx' not found (expected ${encUrl}).`);
    }
    let headBuf;
    try {
        headBuf = await fetchArrayBuffer(headUrl);
    } catch  {
        throw new Error(`Incompatible model: 'head.onnx' not found (expected ${headUrl}).`);
    }
    let enc;
    try {
        enc = await ort.InferenceSession.create(new Uint8Array(encBuf), {
            executionProviders: [
                "webgpu",
                "wasm"
            ]
        });
    } catch (e) {
        enc = await ort.InferenceSession.create(new Uint8Array(encBuf), {
            executionProviders: [
                "wasm"
            ]
        });
    }
    // Patched for cut: the head runs on WebGPU as well (upstream: WASM only), and the encoder's output
    // tensor goes straight to the head instead of through nested JS arrays. Together ~3x faster.
    let head;
    try {
        head = await ort.InferenceSession.create(new Uint8Array(headBuf), {
            executionProviders: [
                "webgpu",
                "wasm"
            ]
        });
    } catch  {
        head = await ort.InferenceSession.create(new Uint8Array(headBuf), {
            executionProviders: [
                "wasm"
            ]
        });
    }
    return {
        runEncoder: async (b)=>{
            try {
                const out = await enc.run(feed(ort, b));
                const t = pickOutput(out, [
                    "last_hidden_state",
                    "lastHidden",
                    "hidden_states"
                ]);
                return {
                    lastHidden: t
                };
            } catch (e) {
                if (isOomError(e)) throw new Error(`${e.message} (WebGPU out of memory; WASM fallback already active)`);
                throw e;
            }
        },
        runHead: async (h, b)=>{
            try {
                const out = await head.run(feedHead(ort, h, b));
                const vals = Object.values(out);
                const lt = pickOutput(out, [
                    "logits"
                ]);
                const at = pickOutput(out, [
                    "act_logits",
                    "act"
                ]) ?? vals[1] ?? vals[0];
                return {
                    logits: toNested(lt.data, lt.dims),
                    act: toNested(at.data, at.dims)
                };
            } catch (e) {
                if (isOomError(e)) throw new Error(`${e.message} (out of memory; try fewer questions per call)`);
                throw e;
            }
        }
    };
}
