// 插件能力目录 + 权限解析。
//
// 权威表是 ../permissions.json（tools/ext.mjs 的插件 lint 也读同一份，避免"文档一套、检查一套"）。
// 本文件只做「声明 → 授予集」的纯逻辑，不碰 DOM/app，所以宿主（cover/ts）与 Node 契约测试
// 都能直接加载。
//
// ⚠ 不是沙箱：插件是同源 ESM，理论上仍能拿到 window。permissions 的作用是
//   ① 把「插件用到了哪一面」变成显式声明；
//   ② 漏声明时在激活现场就报错（而不是"看起来装上了其实没生效"）；
//   ③ 让站点能按策略关掉某一面（policy.denyPermissions）。
//   真正的隔离要等 B08 Worker/iframe 沙箱，那是另一件事。

import catalog from "../permissions.json";

export type ExtPermission =
    | "sim.observe"
    | "sim.control"
    | "ui.command"
    | "ui.panel"
    | "ui.menu"
    | "element.register"
    | "document.hook";

export interface ExtPermissionDef {
    id: ExtPermission;
    /** 中文短名，报错与文档里用 */
    label: string;
    /** 对应的 ctx 面，写成人能看懂的形式 */
    surface: string;
    summary: string;
    /** lint 用的源码特征；null = 只能运行期判定（如 ui.menu 取决于 register 的参数） */
    check?: string | null;
}

const RAW: any[] = (catalog as any)?.permissions ?? [];
const RAW_IDS: string[] = RAW.map((d) => String(d?.id ?? ""));

// 联合类型与 permissions.json 的一致性由 tests/contract/permissions.test.mjs 把关
// （它拿字面量列表与 EXT_PERMISSION_IDS 双向核对）——类型层面做不到：JSON 的 id 是 string，
// 任何"编译期防漂移"写法最后都得靠 cast，等于没检查。

export const EXT_PERMISSIONS: readonly ExtPermissionDef[] = Object.freeze(
    RAW.map((d) =>
        Object.freeze({
            id: String(d.id) as ExtPermission,
            label: String(d.label ?? d.id),
            surface: String(d.surface ?? ""),
            summary: String(d.summary ?? ""),
            check: d.check ?? null,
        }),
    ),
);

export const EXT_PERMISSION_IDS: readonly ExtPermission[] = Object.freeze(
    RAW_IDS.slice() as ExtPermission[],
);

export function isExtPermission(v: unknown): v is ExtPermission {
    return typeof v === "string" && EXT_PERMISSION_IDS.includes(v as ExtPermission);
}

/** 错误归因：作者漏声明 / 站点策略拦下 / 名字写错。三者处置完全不同，别混成一句"没权限"。 */
export type ExtPermissionDenial = "undeclared" | "denied-by-policy" | "unknown";

export class ExtPermissionError extends Error {
    readonly code = "ext/eperm";
    readonly pluginId: string;
    readonly permission: string;
    readonly denial: ExtPermissionDenial;
    /** 被拒的入口，如 "ctx.panel"（报错文案里指路用） */
    readonly surface: string;

    // 显式字段赋值而非构造器参数属性：Node 的 strip-only 类型擦除不支持参数属性，
    // 而这份契约会被 tests/contract/fiber.test.mjs / permissions.test.mjs 直接加载。
    constructor(pluginId: string, permission: string, denial: ExtPermissionDenial, surface?: string) {
        super(permissionMessage(pluginId, permission, denial, surface));
        this.name = "ExtPermissionError";
        this.pluginId = pluginId;
        this.permission = permission;
        this.denial = denial;
        this.surface = surface ?? "";
    }
}

function permissionMessage(
    pluginId: string,
    permission: string,
    denial: ExtPermissionDenial,
    surface?: string,
): string {
    const at = surface ? `调用了 ${surface}，` : "";
    if (denial === "unknown") {
        return `插件 "${pluginId}" 声明了未知权限 "${permission}"；可用：${EXT_PERMISSION_IDS.join(" / ")}`;
    }
    if (denial === "denied-by-policy") {
        return `插件 "${pluginId}" ${at}但权限 "${permission}" 已被站点策略禁用（plugins.manifest.json 的 policy.denyPermissions）`;
    }
    return `插件 "${pluginId}" ${at}但 manifest 未声明权限 "${permission}"；` +
        `在 permissions 里加上它，或用 ctx.permits("${permission}") 先判断`;
}

/**
 * 校验并规范化 manifest 里的 `permissions`。
 * 缺省（undefined/null）= 空（什么也不给）；名字写错**直接抛**——静默忽略拼写错误等于
 * 让插件在运行期莫名其妙少一半能力。
 */
export function resolveDeclaredPermissions(declared: unknown, pluginId: string): ExtPermission[] {
    if (declared == null) return [];
    if (!Array.isArray(declared)) {
        throw new Error(`插件 "${pluginId}" 的 permissions 必须是字符串数组（收到 ${typeof declared}）`);
    }
    const out: ExtPermission[] = [];
    for (const raw of declared) {
        if (typeof raw !== "string") {
            throw new Error(`插件 "${pluginId}" 的 permissions 里出现非字符串项：${JSON.stringify(raw)}`);
        }
        if (!isExtPermission(raw)) throw new ExtPermissionError(pluginId, raw, "unknown");
        if (!out.includes(raw)) out.push(raw);
    }
    return out;
}

/** 不抛、只算：声明 ∩ 未被策略拒绝。宿主用它得到「实际授予集」与「被策略拒掉的」。 */
export function applyPermissionPolicy(
    declared: readonly ExtPermission[],
    deny: readonly string[] = [],
): { granted: ExtPermission[]; denied: ExtPermission[] } {
    const blocked = new Set(deny);
    const granted: ExtPermission[] = [];
    const denied: ExtPermission[] = [];
    for (const p of declared) (blocked.has(p) ? denied : granted).push(p);
    return { granted, denied };
}
