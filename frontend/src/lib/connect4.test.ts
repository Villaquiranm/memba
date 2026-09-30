import { beforeEach, describe, expect, it, vi } from "vitest"

const qeval = vi.hoisted(() => vi.fn())
vi.mock("./dao/shared", async (orig) => ({ ...(await orig<typeof import("./dao/shared")>()), queryEval: qeval }))
vi.mock("./config", async (orig) => ({
    ...(await orig<typeof import("./config")>()),
    connect4PathFor: () => "gno.land/r/test/c4",
    GNO_RPC_URL: "https://rpc.test",
}))

import { getActive, getGame, isGame, type Game } from "./connect4"

export const sample: Game = {
    id: 3, creator: "g1creator", opponent: "", acceptor: "g1acceptor", stake: 2_000_000, fee: 100_000,
    expiresAt: 1_000, commitment: "a".repeat(64), board: "0".repeat(42), turn: 1, turnPlayer: "g1creator",
    moves: 0, lastCol: 0, lastRow: 0, deadline: 1_090, status: "playing", winner: "",
}
const wrap = (v: unknown) => `(${JSON.stringify(JSON.stringify(v))} string)`

beforeEach(() => qeval.mockReset())

describe("isGame", () => {
    it("accepts a valid game", () => expect(isGame(sample)).toBe(true))
    it.each([
        ["short board", { ...sample, board: "0".repeat(41) }],
        ["bad board char", { ...sample, board: "3" + "0".repeat(41) }],
        ["turn 3", { ...sample, turn: 3 }],
        ["unknown status", { ...sample, status: "paused" }],
        ["string stake", { ...sample, stake: "2000000" }],
        ["missing winner", { ...sample, winner: undefined }],
        ["null", null],
    ])("rejects %s", (_, v) => expect(isGame(v)).toBe(false))
})

describe("getGame", () => {
    it("queries GameJSON with the integer id and returns the game", async () => {
        qeval.mockResolvedValue(wrap({ now: 1_050, game: sample }))
        await expect(getGame(3)).resolves.toEqual({ now: 1_050, game: sample })
        expect(qeval).toHaveBeenCalledWith("https://rpc.test", "gno.land/r/test/c4", "GameJSON(3)", false)
    })
    it("maps an unknown or malformed game to game: null", async () => {
        qeval.mockResolvedValue(wrap({ now: 1, game: null }))
        await expect(getGame(9)).resolves.toEqual({ now: 1, game: null })
        qeval.mockResolvedValue(wrap({ now: 1, game: { ...sample, turn: 7 } }))
        await expect(getGame(9)).resolves.toEqual({ now: 1, game: null })
    })
    it.each([-1, 1.5, Number.NaN, 2 ** 60])("never queries for id %s", async (id) => {
        await expect(getGame(id)).resolves.toBeNull()
        expect(qeval).not.toHaveBeenCalled()
    })
    it("returns null when the node fails", async () => {
        qeval.mockResolvedValue(null)
        await expect(getGame(3)).resolves.toBeNull()
    })
})

describe("getActive", () => {
    it("filters malformed entries and clamps paging", async () => {
        qeval.mockResolvedValue(wrap({ now: 5, games: [sample, { id: "x" }] }))
        await expect(getActive(0, 500)).resolves.toEqual({ now: 5, games: [sample] })
        expect(qeval).toHaveBeenCalledWith("https://rpc.test", "gno.land/r/test/c4", "ActiveJSON(0, 100)", false)
    })
    it("never queries with a non-integer offset", async () => {
        await expect(getActive(-1, 10)).resolves.toBeNull()
        expect(qeval).not.toHaveBeenCalled()
    })
})
