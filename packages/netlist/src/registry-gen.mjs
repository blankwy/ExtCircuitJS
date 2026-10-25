#!/usr/bin/env node
/**
 * registry-gen.mjs -- auto-extract the circuitjs1 element description table
 * from the TypeScript sources (read-only).  Nothing here is hand-written per
 * element; every entry is derived from the source text by the rules below.
 *
 * Run via:  node tools/ext.mjs netlist registry
 *
 * Extraction rules (all observed in the upstream sources, see docs/spikes/netlist-codec.md):
 *   R1  `export class X extends Y`                        -> class name + parent
 *   R2  `getDumpType(): number { return 'c'.charCodeAt(0) }` -> txt dump type (char)
 *       `getDumpType(): number { return 150 }`              -> txt dump type (int)
 *   R3  `getXmlDumpType(): string { return "ln" }`        -> xml tag
 *       else CircuitElm.getXmlDumpType() rule: 64<t<127 -> char, else className-'Elm'
 *   R4  constructor(...st...) body: each `st.nextToken()` occurrence is one txt
 *       parameter slot; the field name is the `this.<field> =` target in front of it.
 *       kind from parseFloatStrict/parseIntStrict/'true' comparison/else string.
 *   R5  `getPostCount(): number { return <expr> }`        -> post count expression
 *   R6  `isGroundElm/isRailElm/isVoltageElm/isBatteryElm/isRemovableWire/
 *       isLabeledNodeElm(): boolean { return true }`      -> boolean traits
 *
 * NOTE: traversal/insertion order is intentionally NOT sorted or "improved";
 * the output must be byte-stable across runs and machines.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/netlist/src
const repoRoot = join(here, "..", "..", "..");
const TS_DIR = process.env.CIRCUITJS_TS ?? join(repoRoot, "core", "ts");
const OUT = join(repoRoot, "packages", "netlist", "src", "registry.json");
const GENERATED_FROM = "core/ts";

const files = readdirSync(TS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** Find `class X extends Y {` and return its body with brace matching. */
function classBodies(src) {
  const out = [];
  const re = /export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)(?:\s+extends\s+([A-Za-z0-9_.]+))?[^{]*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = src.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    out.push({ name: m[1], parent: m[2] ?? null, body: src.slice(start, end + 1) });
  }
  return out;
}

/** Extract a method body by name (first occurrence at any depth). */
function methodBody(body, name) {
  const re = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`, "g");
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(start, i + 1); }
  }
  return null;
}

function dumpType(body) {
  const b = methodBody(body, "getDumpType");
  if (!b) return null;
  const c = /\breturn\s+'((?:\\.|[^'\\]))'\.charCodeAt\(0\)/.exec(b);
  if (c) return c[1].charCodeAt(0);
  const n = /\breturn\s+(\d+)\s*;/.exec(b);
  if (n) return Number(n[1]);
  return null; // e.g. `return 0;` in the base class / unknown
}

function xmlType(body, cls) {
  const b = methodBody(body, "getXmlDumpType");
  if (!b) return null;
  const lit = /\breturn\s+"([^"]*)"/.exec(b);
  if (lit) return lit[1];
  // computed tag: return this.getClassName().replace("GateElm", "")
  const rep = /getClassName\(\)\.replace\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/.exec(b);
  if (rep && cls.endsWith(rep[1])) return cls.slice(0, -rep[1].length) + rep[2];
  return null;
}

const TRAITS = [
  "isGroundElm", "isRailElm", "isVoltageElm", "isBatteryElm", "isRemovableWire",
  "isLabeledNodeElm", "isWireElm", "isResistorElm", "isCapacitorElm", "isInductorElm",
];
function traits(body) {
  const t = {};
  for (const name of TRAITS) {
    const b = methodBody(body, name);
    if (b && /\breturn\s+true\s*;/.test(b)) t[name] = true;
  }
  return t;
}

const KINDS = [
  [/parseFloatStrict|parseFloat/, "float"],
  [/parseIntStrict|parseInt/, "int"],
  [/'true'\s*\)|=== *'true'/, "bool"],
];
function kindOf(snippet) {
  for (const [re, k] of KINDS) if (re.test(snippet)) return k;
  return "string";
}

/**
 * R4: walk the constructor body, record every nextToken() with the field it
 * feeds and whether it sits inside a conditional (flag dependent) branch.
 */
function ctorSlots(body) {
  const b = methodBody(body, "constructor");
  if (!b) return [];
  const slots = [];
  const re = /st!?\s*\.\s*nextToken\s*\(/g;
  let m;
  while ((m = re.exec(b))) {
    const lookback = b.slice(Math.max(0, m.index - 220), m.index);
    const fm = /this\.([A-Za-z0-9_]+)\s*[+\-|&]?=\s*[^;=]*$/.exec(lookback);
    const vm = /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*[^;]*$/.exec(lookback);
    const callSite = b.slice(m.index, m.index + 80);
    // conditional if an `if (`/`else` appears after the previous statement boundary
    const stmtStart = Math.max(
      lookback.lastIndexOf(";"), lookback.lastIndexOf("{"), lookback.lastIndexOf("}"), 0
    );
    const cond = /\bif\s*\(|\belse\b/.test(lookback.slice(stmtStart));
    slots.push({
      field: fm ? fm[1] : vm ? vm[1] : null,
      kind: kindOf(callSite),
      conditional: cond,
    });
  }
  return slots;
}

/** R7: per-element XML attribute table, extracted from dumpXml/undumpXml.
 *  dumpXml gives the wire name (the `dumpAttr(elem,"r",this.resistance)` call),
 *  undumpXml gives the decode type (parseDoubleAttr/parseIntAttr/parseStringAttr/
 *  parseBooleanAttr) which is what a schema needs for defaults and coercion. */
function xmlAttrTable(body) {
  const attrs = new Map();
  const dump = methodBody(body, "dumpXml");
  if (dump) {
    const re = /dumpAttr\s*\(\s*elem\s*,\s*"([^"]+)"\s*,\s*([^)]+)\)/g;
    let m;
    while ((m = re.exec(dump))) {
      const field = (/this\.([A-Za-z0-9_]+)/.exec(m[2]) ?? [, null])[1];
      attrs.set(m[1], { attr: m[1], field, dumpExpr: m[2].trim(), kind: null });
    }
  }
  const und = methodBody(body, "undumpXml");
  if (und) {
    const re = /(parseDoubleAttr|parseIntAttr|parseStringAttr|parseBooleanAttr|parse[A-Za-z]*Attr)\s*\(\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(und))) {
      const kind = m[1].includes("Double") ? "float" : m[1].includes("Int") ? "int"
        : m[1].includes("Boolean") ? "bool" : "string";
      const a = attrs.get(m[2]) ?? { attr: m[2], field: null, dumpExpr: null, kind: null };
      a.kind = kind;
      attrs.set(m[2], a);
    }
  }
  return [...attrs.values()];
}

function postCountExpr(body) {
  const b = methodBody(body, "getPostCount");
  if (!b) return null;
  const r = /\breturn\s+([^;]+);/.exec(b);
  return r ? r[1].trim() : null;
}

const registry = { generatedFrom: GENERATED_FROM, elements: {}, byTxtType: {}, byXmlType: {} };
let scanned = 0;

for (const file of files) {
  const src = readFileSync(join(TS_DIR, file), "utf8");
  for (const { name, parent, body } of classBodies(src)) {
    scanned++;
    const dt = dumpType(body);
    const xt = xmlType(body, name);
    const pc = postCountExpr(body);
    const tr = traits(body);
    const slots = ctorSlots(body);
    const entry = {
      cls: name,
      parent,
      file,
      txtType: dt,                       // null => not dumpable in .txt
      xmlType: xt,                        // null => default rule
      xmlTypeDeclared: xt != null,
      postCountExpr: pc,                 // null => inherit 2
      traits: tr,
      txtSlots: slots,
      xmlAttrs: xmlAttrTable(body),
      staticArity: slots.filter((s) => !s.conditional).length,
      maxArity: slots.length,
    };
    registry.elements[name] = entry;
  }
}

// resolve xmlType default per CircuitElm.getXmlDumpType()
for (const e of Object.values(registry.elements)) {
  if (e.xmlType == null) {
    if (e.txtType != null && e.txtType > 64 && e.txtType < 127)
      e.xmlType = String.fromCharCode(e.txtType);
    else
      e.xmlType = e.cls.replace(/Elm$/, "");
  }
  if (e.txtType != null && e.txtType > 0) {
    const prev = registry.byTxtType[e.txtType];
    if (prev == null) registry.byTxtType[e.txtType] = e.cls;
    else registry.txtTypeConflict = [...(registry.txtTypeConflict ?? []), [e.txtType, prev, e.cls]];
  }
  const prevX = registry.byXmlType[e.xmlType];
  if (prevX == null) registry.byXmlType[e.xmlType] = e.cls;
  else registry.xmlTypeConflict = [...(registry.xmlTypeConflict ?? []), [e.xmlType, prevX, e.cls]];
}

registry.stats = {
  filesScanned: files.length,
  classesScanned: scanned,
  elementsWithTxtType: Object.values(registry.elements).filter((e) => e.txtType > 0).length,
  elementsWithSlots: Object.values(registry.elements).filter((e) => e.txtSlots.length > 0).length,
};
writeFileSync(OUT, JSON.stringify(registry, null, 1));
console.log(JSON.stringify({ out: OUT, ...registry.stats, txtConflicts: registry.txtTypeConflict?.length ?? 0, xmlConflicts: registry.xmlTypeConflict?.length ?? 0 }));
