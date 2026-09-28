import { beforeEach, describe, expect, it, vi } from "vitest"
import { getLaunchpadNftCollection } from "./launchpadNft"
import { freezeMetadataRequest, prepareRevealMetadataRequest } from "./launchpadNftReveal"

vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))

const creator = `g1${"p".repeat(38)}`
const baseURI = "ipfs://a/"
const hash = "7b9747382ecd72ad9efd1a9a871bf3fe8de486d54496c7b027b8add56dc3b690"
const collection = { id: "C1", name: "Civic Art", creator, metadataMode: "reveal_base", revealed: false,
    metadataFrozen: false, baseURI: "", baseURICommitment: hash, provenanceHash: "b".repeat(64),
    placeholderURI: "ipfs://placeholder/a.json", minted: 0n } as never

describe("creator metadata commitment actions", () => {
    beforeEach(() => vi.resetAllMocks())

    it("requires the exact committed IPFS URI before opening wallet review", async () => {
        const input = { collection, creator, baseURI, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 }
        const request = await prepareRevealMetadataRequest(input)
        expect(request.prepare(undefined).msgs[0].value).toMatchObject({ caller: creator, send: "", func: "Reveal", args: ["C1", baseURI] })
        expect(request.lines(undefined)).toContainEqual(["First token URI", "ipfs://a/1.json"])
        await expect(prepareRevealMetadataRequest({ ...input, baseURI: "ipfs://different/" })).rejects.toThrow("does not match")
        await expect(prepareRevealMetadataRequest({ ...input, baseURI: "https://a/" })).rejects.toThrow("IPFS")
    })

    it("rechecks the commitment and confirms the reveal state", async () => {
        const request = await prepareRevealMetadataRequest({ collection, creator, baseURI,
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(collection)
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ ...collection, baseURICommitment: "a".repeat(64) })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ ...collection, revealed: true, baseURI })
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
    })

    it("freezes only a revealed creator collection and verifies finality", async () => {
        const revealed = { ...collection, revealed: true, baseURI, metadataFrozen: false }
        const request = freezeMetadataRequest({ collection: revealed, creator, rpcUrl: "rpc",
            chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        expect(request.prepare(undefined).msgs[0].value).toMatchObject({ caller: creator, send: "", func: "FreezeMetadata", args: ["C1"] })
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(revealed)
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ ...revealed, metadataFrozen: true })
        await expect(request.recheck?.(undefined)).rejects.toThrow("cannot be frozen")
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ ...revealed, metadataFrozen: true })
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        expect(() => freezeMetadataRequest({ collection, creator, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })).toThrow("cannot")
    })
})
