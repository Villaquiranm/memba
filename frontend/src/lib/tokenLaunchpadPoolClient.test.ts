import { beforeEach, describe, expect, it, vi } from "vitest"
import { AbciQueryError } from "./rpcFallback"

const queryEval = vi.fn()
const currentNetworkKey = vi.fn(() => "mainnet")
const isRealmValidOn = vi.fn(() => true)
vi.mock("./dao/shared", async (load) => ({
    ...(await load<typeof import("./dao/shared")>()),
    queryEval: (...args: unknown[]) => queryEval(...args),
}))
vi.mock("./config", async (load) => ({
    ...(await load<typeof import("./config")>()),
    ACTIVE_NETWORK_KEY: "mainnet",
    GNO_RPC_URL: "https://rpc.example",
    currentNetworkKey: () => currentNetworkKey(),
    isRealmValidOn: (...args: unknown[]) => isRealmValidOn(...args),
}))

import { parseLaunchpadPool, parseLaunchpadPoolAdditionQuote, TokenLaunchpadPoolClient, TOKEN_LAUNCHPAD_POOL_PATH } from "./tokenLaunchpadPoolClient"

const CREATOR = "g1x7k4628w93a7wzdhqc06atzx0v50rnshweuxu0"
const record = () => ({
    schema: "launchpad-pool-v1", id: "T1", quoteCurrency: "ugnot",
    configVersion: "9007199254740993", creator: CREATOR,
    tokenReserve: "9223372036854775807", quoteReserve: "1002",
})
const addition = () => ({
    ...record(), schema: "launchpad-pool-addition-quote-v1",
    tokenReserve: "9007199254740993", quoteReserve: "9007199254740993",
    tokenIn: "1", quoteIn: "1",
    newTokenReserve: "9007199254740994", newQuoteReserve: "9007199254740994",
})
const qjson = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`

beforeEach(() => {
    queryEval.mockReset()
    currentNetworkKey.mockReturnValue("mainnet")
    isRealmValidOn.mockReset()
    isRealmValidOn.mockReturnValue(true)
})

describe("Token Launchpad pool reader", () => {
    it("keeps reserve and version base units exact", () => {
        const pool = parseLaunchpadPool(record())
        expect(pool.tokenReserve).toBe(9223372036854775807n)
        expect(pool.configVersion).toBe(9007199254740993n)
        expect(pool.quoteReserve).toBe(1002n)
    })

    it("keeps addition quotes exact and checks the recorded ratio", () => {
        const quote = parseLaunchpadPoolAdditionQuote(addition())
        expect(quote.tokenReserve).toBe(9007199254740993n)
        expect(quote.quoteIn).toBe(1n)
        expect(quote.newQuoteReserve).toBe(9007199254740994n)
        for (const bad of [
            { ...addition(), schema: "launchpad-pool-v1" },
            { ...addition(), tokenIn: "0" },
            { ...addition(), tokenIn: "01" },
            { ...addition(), tokenIn: "9".repeat(100000) },
            { ...addition(), quoteIn: "2" },
            { ...addition(), newTokenReserve: "9007199254740995" },
            { ...addition(), newQuoteReserve: "9223372036854775808" },
        ]) expect(() => parseLaunchpadPoolAdditionQuote(bad)).toThrow()
    })

    it("rejects malformed identity, amount and schema fields before BigInt parsing", () => {
        for (const bad of [
            { ...record(), schema: "other" },
            { ...record(), id: "T01" },
            { ...record(), creator: "g1bad" },
            { ...record(), configVersion: "0" },
            { ...record(), quoteCurrency: "" },
            { ...record(), quoteCurrency: "x".repeat(201) },
            { ...record(), tokenReserve: "0" },
            { ...record(), quoteReserve: 1002 },
            { ...record(), quoteReserve: "01" },
            { ...record(), quoteReserve: "9".repeat(100000) },
            { ...record(), quoteReserve: "9223372036854775808" },
        ]) expect(() => parseLaunchpadPool(bad)).toThrow()
    })

    it("queries the guarded pool path and rejects a swapped token ID", async () => {
        const client = new TokenLaunchpadPoolClient()
        queryEval.mockResolvedValueOnce(qjson(record()))
        expect((await client.pool("T1")).quoteReserve).toBe(1002n)
        expect(queryEval).toHaveBeenCalledWith("https://rpc.example", TOKEN_LAUNCHPAD_POOL_PATH, 'PoolJSON("T1")', true)
        queryEval.mockResolvedValueOnce(qjson({ ...record(), id: "T2" }))
        await expect(client.pool("T1")).rejects.toMatchObject({ code: "invalid_response" })
        await expect(client.pool('T1");panic(1)//')).rejects.toMatchObject({ code: "invalid_response" })
        expect(queryEval).toHaveBeenCalledTimes(2)
    })

    it("quotes one exact amount on the guarded path and rejects swapped requests", async () => {
        const client = new TokenLaunchpadPoolClient()
        queryEval.mockResolvedValueOnce(qjson(addition()))
        expect((await client.quoteAddition("T1", 1n)).quoteIn).toBe(1n)
        expect(queryEval).toHaveBeenCalledWith("https://rpc.example", TOKEN_LAUNCHPAD_POOL_PATH, 'QuoteAdditionJSON("T1",1)', true)
        queryEval.mockResolvedValueOnce(qjson({ ...addition(), id: "T2" }))
        await expect(client.quoteAddition("T1", 1n)).rejects.toMatchObject({ code: "invalid_response" })
        queryEval.mockResolvedValueOnce(qjson({ ...addition(), tokenIn: "2", quoteIn: "2", newTokenReserve: "9007199254740995", newQuoteReserve: "9007199254740995" }))
        await expect(client.quoteAddition("T1", 1n)).rejects.toMatchObject({ code: "invalid_response" })
        await expect(client.quoteAddition("T1", 0n)).rejects.toMatchObject({ code: "invalid_response" })
        await expect(client.quoteAddition("T1", 9223372036854775808n)).rejects.toMatchObject({ code: "invalid_response" })
        expect(queryEval).toHaveBeenCalledTimes(3)
    })

    it("guards quote reads across network changes and realm errors", async () => {
        const client = new TokenLaunchpadPoolClient()
        isRealmValidOn.mockReturnValueOnce(false)
        await expect(client.quoteAddition("T1", 1n)).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockRejectedValueOnce(new AbciQueryError("vm/qeval", "missing"))
        await expect(client.quoteAddition("T1", 1n)).rejects.toMatchObject({ code: "realm_error" })
        queryEval.mockImplementationOnce(async () => { currentNetworkKey.mockReturnValue("testnet"); return qjson(addition()) })
        await expect(client.quoteAddition("T1", 1n)).rejects.toMatchObject({ code: "network_changed" })
    })

    it("keeps unavailable, network changes, realm errors and RPC errors distinct", async () => {
        const client = new TokenLaunchpadPoolClient()
        isRealmValidOn.mockReturnValueOnce(false)
        await expect(client.pool("T1")).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockResolvedValueOnce(null)
        await expect(client.pool("T1")).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockRejectedValueOnce(new AbciQueryError("vm/qeval", "missing"))
        await expect(client.pool("T1")).rejects.toMatchObject({ code: "realm_error" })
        queryEval.mockRejectedValueOnce(new Error("offline"))
        await expect(client.pool("T1")).rejects.toMatchObject({ code: "rpc_error" })
        queryEval.mockImplementationOnce(async () => { currentNetworkKey.mockReturnValue("testnet"); return qjson(record()) })
        await expect(client.pool("T1")).rejects.toMatchObject({ code: "network_changed" })
    })

    it("keeps the unpublished pool realm out of the real mainnet allowlist", async () => {
        const config = await vi.importActual<typeof import("./config")>("./config")
        expect(config.isRealmValidOn("mainnet", TOKEN_LAUNCHPAD_POOL_PATH)).toBe(false)
    })
})
