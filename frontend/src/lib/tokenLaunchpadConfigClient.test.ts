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

import { parseLaunchpadActionStatus, TokenLaunchpadConfigClient, TOKEN_LAUNCHPAD_CONFIG_PATH } from "./tokenLaunchpadConfigClient"

const record = () => ({
    schema: "launchpad-config-action-v1", lane: "direct", currency: "ugnot",
    version: "9007199254740993", paused: false, allowlisted: true,
    laneReady: true, configGateOpen: true,
})
const qjson = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`

beforeEach(() => {
    queryEval.mockReset()
    currentNetworkKey.mockReturnValue("mainnet")
    isRealmValidOn.mockReset()
    isRealmValidOn.mockReturnValue(true)
})

describe("Token Launchpad config gate reader", () => {
    it("keeps the current version exact and accepts each independent closed gate", () => {
        expect(parseLaunchpadActionStatus(record()).version).toBe(9007199254740993n)
        for (const gate of [
            { paused: true, configGateOpen: false },
            { allowlisted: false, configGateOpen: false },
            { laneReady: false, configGateOpen: false },
        ]) expect(parseLaunchpadActionStatus({ ...record(), ...gate }).configGateOpen).toBe(false)
    })

    it("rejects invalid and inconsistent snapshots before trusting the gate", () => {
        for (const bad of [
            { ...record(), schema: "other" },
            { ...record(), lane: "unknown" },
            { ...record(), currency: "" },
            { ...record(), currency: "x".repeat(201) },
            { ...record(), version: 2 },
            { ...record(), version: "0" },
            { ...record(), version: "01" },
            { ...record(), version: "9".repeat(100000) },
            { ...record(), version: "9223372036854775808" },
            { ...record(), paused: "false" },
            { ...record(), paused: true },
            { ...record(), configGateOpen: false },
        ]) expect(() => parseLaunchpadActionStatus(bad)).toThrow()
    })

    it("uses bounded query arguments and rejects a swapped response", async () => {
        const client = new TokenLaunchpadConfigClient()
        queryEval.mockResolvedValueOnce(qjson(record()))
        expect((await client.actionStatus("direct", "ugnot")).configGateOpen).toBe(true)
        expect(queryEval).toHaveBeenCalledWith("https://rpc.example", TOKEN_LAUNCHPAD_CONFIG_PATH, 'ActionStatusJSON("direct","ugnot")', true)
        queryEval.mockResolvedValueOnce(qjson({ ...record(), currency: "other" }))
        await expect(client.actionStatus("direct", "ugnot")).rejects.toMatchObject({ code: "invalid_response" })
        await expect(client.actionStatus("direct", "x".repeat(201))).rejects.toMatchObject({ code: "invalid_response" })
        expect(queryEval).toHaveBeenCalledTimes(2)
    })

    it("distinguishes unavailable, network changes, realm errors and RPC errors", async () => {
        const client = new TokenLaunchpadConfigClient()
        isRealmValidOn.mockReturnValueOnce(false)
        await expect(client.actionStatus("direct", "ugnot")).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockResolvedValueOnce(null)
        await expect(client.actionStatus("direct", "ugnot")).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockRejectedValueOnce(new AbciQueryError("vm/qeval", "missing"))
        await expect(client.actionStatus("direct", "ugnot")).rejects.toMatchObject({ code: "realm_error" })
        queryEval.mockRejectedValueOnce(new Error("offline"))
        await expect(client.actionStatus("direct", "ugnot")).rejects.toMatchObject({ code: "rpc_error" })
        queryEval.mockImplementationOnce(async () => { currentNetworkKey.mockReturnValue("testnet"); return qjson(record()) })
        await expect(client.actionStatus("direct", "ugnot")).rejects.toMatchObject({ code: "network_changed" })
    })

    it("keeps the unpublished realm out of the real mainnet allowlist", async () => {
        const config = await vi.importActual<typeof import("./config")>("./config")
        expect(config.isRealmValidOn("mainnet", TOKEN_LAUNCHPAD_CONFIG_PATH)).toBe(false)
    })
})
