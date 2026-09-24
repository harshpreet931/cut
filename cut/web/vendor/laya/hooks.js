export class PredictContext {
    states;
    questions;
    runId;
    results = null;
    decision = null;
    model = null;
    agent = null;
    router = null;
    maxLen = null;
    headMaxLen = null;
    usage = null;
    startedAt;
    elapsedMs = null;
    error = null;
    constructor(init){
        this.states = init.states;
        this.questions = init.questions;
        this.runId = newRunId();
        this.startedAt = now();
        for (const [k, v] of Object.entries(init)){
            if (k !== "states" && k !== "questions" && v !== undefined) {
                this[k] = v;
            }
        }
    }
    skip(results) {
        this.results = results;
    }
    markElapsed() {
        this.elapsedMs = now() - this.startedAt;
    }
}
function newRunId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID().replaceAll("-", "");
    let hex = "";
    for(let i = 0; i < 32; i++)hex += Math.floor(Math.random() * 16).toString(16);
    return hex;
}
function now() {
    const p = globalThis.performance;
    return p && typeof p.now === "function" ? p.now() : Date.now();
}
export const HOOK_EVENTS = [
    "onPredictStart",
    "onPredictEnd",
    "onRoute",
    "onLoad",
    "onEvict",
    "onError"
];
export class BaseHook {
    onPredictStart(_ctx) {}
    onPredictEnd(_ctx) {}
    onRoute(_ctx) {}
    onLoad(_ctx) {}
    onEvict(_ctx) {}
    onError(_ctx) {}
}
function isHookLike(item) {
    return typeof item === "object" && item !== null && HOOK_EVENTS.some((e)=>typeof item[e] === "function");
}
function typeName(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "Array";
    if (typeof v === "object") return v.constructor?.name ?? "object";
    return typeof v;
}
export function normaliseHooks(hooks, onPredictStart, onPredictEnd) {
    const out = [];
    const append = (item)=>{
        if (item === null || item === undefined) return;
        if (typeof item === "function") {
            if (HOOK_EVENTS.some((e)=>typeof item[e] === "function")) {
                throw new TypeError("a hook must be a plain callable or implement hook methods, not both");
            }
            throw new TypeError("a plain callable is ambiguous; pass it as onPredictStart or onPredictEnd");
        }
        if (Array.isArray(item)) {
            for (const h of item)append(h);
            return;
        }
        if (typeof item !== "object") {
            throw new TypeError(`hooks must be Hook objects, got ${typeName(item)}`);
        }
        if (!isHookLike(item)) {
            throw new TypeError(`a hook must implement at least one hook method (${HOOK_EVENTS.join(", ")})`);
        }
        out.push(item);
    };
    append(hooks);
    if (onPredictStart !== null && onPredictStart !== undefined) {
        if (typeof onPredictStart !== "function") {
            throw new TypeError(`onPredictStart must be callable, got ${typeName(onPredictStart)}`);
        }
        out.push({
            onPredictStart
        });
    }
    if (onPredictEnd !== null && onPredictEnd !== undefined) {
        if (typeof onPredictEnd !== "function") {
            throw new TypeError(`onPredictEnd must be callable, got ${typeName(onPredictEnd)}`);
        }
        out.push({
            onPredictEnd
        });
    }
    if (onPredictStart !== null && onPredictStart !== undefined && onPredictStart === onPredictEnd) {
        throw new TypeError("onPredictStart and onPredictEnd must be different callables; one callable cannot serve both events");
    }
    return out;
}
const defaultHooksList = [];
export function defaultHooks() {
    return [
        ...defaultHooksList
    ];
}
export function setDefaultHooks(hooks, onPredictStart, onPredictEnd) {
    const normalised = normaliseHooks(hooks, onPredictStart, onPredictEnd);
    defaultHooksList.length = 0;
    defaultHooksList.push(...normalised);
}
export function addDefaultHook(hook) {
    defaultHooksList.push(...normaliseHooks(hook));
}
export function clearDefaultHooks() {
    defaultHooksList.length = 0;
}
export function composeHooks(installed, hooks, onPredictStart, onPredictEnd) {
    return [
        ...defaultHooksList,
        ...installed,
        ...normaliseHooks(hooks, onPredictStart, onPredictEnd)
    ];
}
export class HookRegistry {
    hooks = [];
    addHook(hook) {
        const added = normaliseHooks(hook);
        if (added.length > 0) this.hooks = [
            ...this.hooks,
            ...added
        ];
        return this;
    }
    removeHook(hook) {
        const before = this.hooks.length;
        this.hooks = this.hooks.filter((installed)=>installed !== hook);
        return this.hooks.length !== before;
    }
    withHooks(hookArgs, fn) {
        const added = normaliseHooks(hookArgs);
        this.hooks = [
            ...this.hooks,
            ...added
        ];
        const release = ()=>{
            this.hooks = this.hooks.filter((installed)=>!added.includes(installed));
        };
        let out;
        try {
            out = fn();
        } catch (err) {
            release();
            throw err;
        }
        if (out instanceof Promise) {
            return out.finally(release);
        }
        release();
        return out;
    }
}
export function aggregateUsage(results) {
    const total = (key)=>results.reduce((acc, r)=>{
            const usage = r?.["usage"];
            const v = usage?.[key];
            return acc + (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
        }, 0);
    return {
        input_tokens: total("input_tokens"),
        output_tokens: total("output_tokens")
    };
}
export function dispatch(hooks, event, ctx, opts = {}) {
    const raiseErrors = opts.raiseErrors ?? true;
    for (const hook of hooks){
        const method = hook?.[event];
        if (typeof method !== "function") continue;
        try {
            method.call(hook, ctx);
        } catch (err) {
            if (raiseErrors) throw err;
            const name = hook?.constructor?.name ?? "hook";
            console.warn(`laya: hook ${name}.${event} failed: ${String(err)}`);
        }
    }
}
