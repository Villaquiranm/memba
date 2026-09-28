import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"
import { getLaunchpadNftToken, listLaunchpadNftCollections, parseLaunchpadNftCollection } from "./launchpadNft"

const row = {
    id: "C1", grc721Id: "1", creator: "g1creator", name: "Founders", symbol: "FND",
    description: "", image: "", banner: "", website: "", mode: "soulbound",
    revocable: true, tradable: false, maxSupply: "100", minted: "2", totalSupply: "1",
    configVersion: "1", profileFrozen: false, metadataMode: "static_base",
    revealed: true, metadataFrozen: true, placeholderURI: "",
    baseURICommitment: "a".repeat(64), provenanceHash: "",
    royaltyBPS: "0", royalties: [], baseURI: "ipfs://metadata/",
}

const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`

describe("Launchpad NFT reads", () => {
    beforeEach(() => vi.restoreAllMocks())

    it("decodes the ledger's exact large-integer JSON without losing precision", async () => {
        const answer = { ...row, maxSupply: "9007199254740993" }
        vi.spyOn(shared, "queryEval").mockResolvedValue(qeval([answer]))
        const result = await listLaunchpadNftCollections("https://rpc.example", 0, 20)
        expect(result).toHaveLength(1)
        expect(result[0].maxSupply).toBe(9007199254740993n)
        expect(result[0].mode).toBe("soulbound")
        expect(shared.queryEval).toHaveBeenCalledWith("https://rpc.example", LAUNCHPAD_NFT_PATH, "ListCollectionsJSON(0, 20)", true)
    })

    it("distinguishes a genuine empty list from RPC and schema failures", async () => {
        const read = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval([])).mockResolvedValueOnce(null).mockResolvedValueOnce(qeval({}))
        await expect(listLaunchpadNftCollections("rpc")).resolves.toEqual([])
        await expect(listLaunchpadNftCollections("rpc")).rejects.toThrow("Could not read")
        await expect(listLaunchpadNftCollections("rpc")).rejects.toThrow("Invalid collection list")
        expect(read).toHaveBeenCalledTimes(3)
    })

    it("rejects inconsistent SoulBound transfer rules and impossible supply", () => {
        expect(() => parseLaunchpadNftCollection({ ...row, tradable: true })).toThrow("Inconsistent collection mode")
        expect(() => parseLaunchpadNftCollection({ ...row, minted: "101" })).toThrow("Inconsistent collection supply")
        expect(() => parseLaunchpadNftCollection({ ...row, totalSupply: 1 })).toThrow("Invalid total supply")
        expect(parseLaunchpadNftCollection({ ...row, maxSupply: "0" }).maxSupply).toBe(0n)
    })

    it("keeps hidden metadata distinct from a verified provenance claim", () => {
        const hidden = { ...row, metadataMode: "reveal_base", revealed: false, metadataFrozen: false,
            placeholderURI: "ipfs://placeholder/placeholder.json", provenanceHash: "b".repeat(64), baseURI: "" }
        expect(parseLaunchpadNftCollection(hidden)).toMatchObject({ revealed: false, metadataFrozen: false, provenanceHash: "b".repeat(64) })
        expect(() => parseLaunchpadNftCollection({ ...hidden, metadataFrozen: true })).toThrow("Inconsistent collection metadata")
        expect(() => parseLaunchpadNftCollection({ ...hidden, baseURI: "ipfs://unrevealed/" })).toThrow("Inconsistent collection metadata")
        expect(() => parseLaunchpadNftCollection({ ...hidden, provenanceHash: "not-a-hash" })).toThrow("Inconsistent collection metadata")
        expect(parseLaunchpadNftCollection({ ...hidden, revealed: true, baseURI: "ipfs://revealed/" }).baseURI).toBe("ipfs://revealed/")
    })

    it("rejects royalty totals or receiver records inconsistent with the ledger", () => {
        const open = { ...row, mode: "open", revocable: false, tradable: true, royaltyBPS: "500",
            royalties: [{ account: "g1receiver", bps: "500" }] }
        expect(parseLaunchpadNftCollection(open).royalties[0].bps).toBe(500n)
        expect(() => parseLaunchpadNftCollection({ ...open, royaltyBPS: "501" })).toThrow("Inconsistent royalty terms")
        expect(() => parseLaunchpadNftCollection({ ...open, royalties: [{ account: "g1receiver", bps: "0" }] })).toThrow("Inconsistent royalty terms")
        expect(() => parseLaunchpadNftCollection({ ...open, mode: "soulbound", revocable: true, tradable: false })).toThrow("Inconsistent royalty terms")
    })

    it("reads an active Soulbound token owner and rejects mismatched token identities", async () => {
        const owner = `g1${"p".repeat(38)}`
        vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval({ collection: "C1", number: "3", owner,
            status: "active", uri: "ipfs://metadata/3.json", soulbound: true }))
        await expect(getLaunchpadNftToken("rpc", "C1", 3n)).resolves.toMatchObject({ owner, soulbound: true, status: "active" })
        vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval({ collection: "C1", number: "4", owner,
            status: "active", uri: "ipfs://metadata/4.json", soulbound: true }))
        await expect(getLaunchpadNftToken("rpc", "C1", 3n)).rejects.toThrow("identity")
    })
})
