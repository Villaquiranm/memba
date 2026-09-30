/**
 * connect4.ts — client for the staked Connect 4 realm (testnet demo).
 *
 * Reads go over vm/qeval to the realm's GameJSON / ActiveJSON accessors;
 * writes go through doContractBroadcast (Adena). Stakes are real ugnot, so the
 * realm path exists only on testnets (connect4PathFor).
 */

import { queryEval, parseQevalJSON } from "./dao/shared"
import { ACTIVE_NETWORK_KEY, GNO_RPC_URL, connect4PathFor } from "./config"

export type Status = "open" | "playing" | "won" | "draw" | "void" | "cancelled"

export interface Game {
    id: number
    creator: string
    opponent: string
    acceptor: string
    stake: number
    fee: number
    expiresAt: number
    commitment: string
    board: string
    turn: 0 | 1 | 2
    turnPlayer: string
    moves: number
    lastCol: number
    lastRow: number
    deadline: number
    status: Status
    winner: string
}

const STATUSES: readonly string[] = ["open", "playing", "won", "draw", "void", "cancelled"]
const BOARD_RE = /^[012]{42}$/

export function isGame(v: unknown): v is Game {
    const o = v as Record<string, unknown> | null
    if (!o || typeof o !== "object") return false
    const nums = ["id", "stake", "fee", "expiresAt", "moves", "lastCol", "lastRow", "deadline"]
    const strs = ["creator", "opponent", "acceptor", "commitment", "turnPlayer", "winner"]
    return nums.every((k) => typeof o[k] === "number")
        && strs.every((k) => typeof o[k] === "string")
        && typeof o.board === "string" && BOARD_RE.test(o.board)
        && (o.turn === 0 || o.turn === 1 || o.turn === 2)
        && typeof o.status === "string" && STATUSES.includes(o.status)
}

export function realmPath(): string | null {
    return connect4PathFor(ACTIVE_NETWORK_KEY)
}

// SECURITY: queryEval does not sanitize. Only integers that pass this check
// are ever interpolated into a qeval expression — never strings.
const isIndex = (n: number) => Number.isSafeInteger(n) && n >= 0

async function evalJSON(expr: string): Promise<Record<string, unknown> | null> {
    const path = realmPath()
    if (!path) return null
    const raw = await queryEval(GNO_RPC_URL, path, expr, false).catch(() => null)
    if (!raw) return null
    const v = parseQevalJSON(raw) as Record<string, unknown> | null
    return v && typeof v.now === "number" ? v : null
}

/** One game with the chain time; game is null when unknown or malformed. Null on failure. */
export async function getGame(id: number): Promise<{ now: number; game: Game | null } | null> {
    if (!isIndex(id)) return null
    const v = await evalJSON(`GameJSON(${id})`)
    if (!v) return null
    return { now: v.now as number, game: isGame(v.game) ? v.game : null }
}

/** Open and Playing games in id order with the chain time. Null on failure. */
export async function getActive(offset: number, limit: number): Promise<{ now: number; games: Game[] } | null> {
    if (!isIndex(offset) || !isIndex(limit)) return null
    const lim = Math.max(1, Math.min(100, limit))
    const v = await evalJSON(`ActiveJSON(${offset}, ${lim})`)
    if (!v) return null
    return { now: v.now as number, games: Array.isArray(v.games) ? v.games.filter(isGame) : [] }
}
