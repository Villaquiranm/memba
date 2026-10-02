/**
 * quickPlay.ts — Connect 4 "Quick play": a gno account session (tm2 auth
 * sessions) whose key lives in this browser, so coin-free moves sign without a
 * wallet popup. Adena creates and revokes the session; Offer/Accept/Cancel
 * never come here. See docs/superpowers/specs/2026-10-02-connect4-quickplay-design.md.
 */
import { ACTIVE_NETWORK_KEY, GNO_CHAIN_ID, GNO_RPC_URL, connect4PathFor } from "./config"
import { doContractBroadcast, feeForGasWanted, networkGasPrice } from "./grc20"
import { keyFromPriv, newSessionKey, pubKeyAnyBytes, signSessionTx, type SessionKey } from "./sessionTx"
import { broadcastSignedTx, CheckTxError } from "./signedTxBroadcast"

export const QUICKPLAY_DURATIONS = [3600, 14400, 86400] as const
export type QuickPlayDuration = (typeof QUICKPLAY_DURATIONS)[number]
const SPEND_LIMIT_UGNOT = 1_000_000
const SPEND_PERIOD = 86_400
const GAS_WANTED = 20_000_000
const MAX_DEPOSIT = "2000000ugnot"
const FUNCS = new Set(["Reveal", "Play", "Resign", "ClaimTimeout"])

export interface QuickPlayStatus { expiresAt: number; spendUsedUgnot: number; spendLimitUgnot: number }
export class QuickPlayUnavailable extends Error {
    name = "QuickPlayUnavailable"
    constructor(readonly reason: "ended" | "budget" | "rejected", message: string) { super(message) }
}

interface Stored { priv: string; sessionAddr: string; expiresAt: number; allowPath: string; chainId: string }
const storageKey = (master: string) => `memba.quickplay.${ACTIVE_NETWORK_KEY}.${master}`
const allowPath = () => { const p = connect4PathFor(ACTIVE_NETWORK_KEY); return p ? `vm/exec:${p}` : null }
const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("")
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16))
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

function read(master: string): (Stored & { key: SessionKey }) | null {
    try {
        const raw = localStorage.getItem(storageKey(master))
        if (!raw) return null
        const s = JSON.parse(raw) as Stored
        if (s.chainId !== GNO_CHAIN_ID || s.allowPath !== allowPath() || !/^[0-9a-f]{64}$/.test(s.priv)) return null
        const key = keyFromPriv(fromHex(s.priv))
        return key.address === s.sessionAddr ? { ...s, key } : null
    } catch { return null }
}
function remove(master: string) { try { localStorage.removeItem(storageKey(master)) } catch { /* nothing stored */ } }

export function hasLocalSession(master: string): boolean { return read(master) !== null }
export function forgetQuickPlay(master: string): void { remove(master) }

interface ChainSession { accountNumber: string; sequence: string; status: QuickPlayStatus; allowPaths: string[] }
async function chainSession(master: string, sessionAddr: string): Promise<ChainSession | null> {
    const res = await fetch(`${GNO_RPC_URL}/abci_query?path=%22auth/accounts/${master}/session/${sessionAddr}%22`)
    const base = (await res.json())?.result?.response?.ResponseBase
    if (!base?.Data) return null
    const d = JSON.parse(atob(base.Data))
    const s = d.BaseSessionAccount
    const ugnot = (c: string | undefined) => Number(/^(\d+)ugnot$/.exec(c ?? "")?.[1] ?? 0)
    const reset = Number(s.spend_reset ?? 0), period = Number(s.spend_period ?? 0)
    const used = period > 0 && Date.now() / 1000 >= reset + period ? 0 : ugnot(s.spend_used)
    return {
        accountNumber: String(s.BaseAccount.account_number), sequence: String(s.BaseAccount.sequence),
        status: { expiresAt: Number(s.expires_at), spendUsedUgnot: used, spendLimitUgnot: ugnot(s.spend_limit) },
        allowPaths: Array.isArray(d.allow_paths) ? d.allow_paths : [],
    }
}

export async function startQuickPlay(master: string, duration: QuickPlayDuration): Promise<QuickPlayStatus> {
    if (!QUICKPLAY_DURATIONS.includes(duration)) throw new Error("Unsupported Quick play duration")
    const path = allowPath()
    if (!path) throw new Error("Connect 4 is not available on this network.")
    const key = newSessionKey()
    const expiresAt = Math.floor(Date.now() / 1000) + duration
    const entry: Stored = { priv: toHex(key.priv), sessionAddr: key.address, expiresAt, allowPath: path, chainId: GNO_CHAIN_ID }
    try { localStorage.setItem(storageKey(master), JSON.stringify(entry)) } catch { throw new Error("Couldn't store the Quick play key on this device, so nothing was sent.") }
    if (!hasLocalSession(master)) throw new Error("Couldn't store the Quick play key on this device, so nothing was sent.")
    try {
        await doContractBroadcast([{ type: "/auth.m_create_session", value: {
            creator: master,
            session_key: { type_url: "/tm.PubKeySecp256k1", value: b64(pubKeyAnyBytes(key.pub).slice(-35)) },
            expires_at: String(expiresAt), allow_paths: [path], spend_limit: `${SPEND_LIMIT_UGNOT}ugnot`, spend_period: String(SPEND_PERIOD),
        } }], "Start Quick play", { retry: false })
        const s = await chainSession(master, key.address)
        if (!s) throw new Error("Quick play wasn't confirmed on chain. Try again.")
        return s.status
    } catch (e) { remove(master); throw e }
}

export async function quickPlayStatus(master: string): Promise<QuickPlayStatus | null> {
    const local = read(master)
    if (!local) return null
    const s = await chainSession(master, local.sessionAddr)
    if (!s || s.status.expiresAt <= Date.now() / 1000) { remove(master); return null }
    return s.status
}

export async function quickPlayCall(master: string, func: "Reveal" | "Play" | "Resign" | "ClaimTimeout", args: string[]): Promise<{ hash: string }> {
    if (!FUNCS.has(func)) throw new Error(`Quick play can't sign ${func}`)
    const local = read(master)
    if (!local) throw new QuickPlayUnavailable("ended", "Quick play isn't on for this account.")
    const fee = feeForGasWanted(GAS_WANTED, await networkGasPrice())
    for (let attempt = 0; attempt < 2; attempt++) {
        const s = await chainSession(master, local.sessionAddr)
        if (!s || s.status.expiresAt <= Date.now() / 1000) { remove(master); throw new QuickPlayUnavailable("ended", "Quick play ended — confirm in your wallet.") }
        if (!s.allowPaths.includes(local.allowPath)) { remove(master); throw new QuickPlayUnavailable("ended", "Quick play ended — confirm in your wallet.") }
        if (s.status.spendUsedUgnot + fee > s.status.spendLimitUgnot) throw new QuickPlayUnavailable("budget", "Quick play budget used up for today.")
        const bytes = signSessionTx({
            key: local.key, chainId: GNO_CHAIN_ID, accountNumber: s.accountNumber, sequence: s.sequence, gas: GAS_WANTED, feeUgnot: fee,
            memo: `Connect 4: ${func}`,
            msg: { caller: master, send: "", max_deposit: MAX_DEPOSIT, pkg_path: local.allowPath.slice("vm/exec:".length), func, args },
        })
        try { return await broadcastSignedTx(GNO_CHAIN_ID, bytes) }
        catch (e) { if (!(e instanceof CheckTxError) || attempt === 1) { if (e instanceof CheckTxError) throw new QuickPlayUnavailable("rejected", e.message); throw e } }
    }
    throw new QuickPlayUnavailable("rejected", "Quick play couldn't sign this move.")
}

export async function endQuickPlay(master: string): Promise<void> {
    const local = read(master)
    if (!local) return
    await doContractBroadcast([{ type: "/auth.m_revoke_session", value: { creator: master, session_key: { type_url: "/tm.PubKeySecp256k1", value: b64(pubKeyAnyBytes(local.key.pub).slice(-35)) } } }], "End Quick play", { retry: false })
    remove(master)
}
