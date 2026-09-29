import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryEval } from "./dao/shared"
import { packageAddress } from "./dao/weightedApplications"
import { readActionTerms } from "./launchpadActionTerms"
import { buildCreateCollectionVariantMsg, createCollectionVariantRequest, encodeCollectionRoyalties,
    type CollectionCreationDraft } from "./launchpadCollectionVariants"
import { getLaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_CURATION_PATH, LAUNCHPAD_CURATION_DAO_PATH, LAUNCHPAD_DROPS_PATH, LAUNCHPAD_FEES_PATH,
    LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH, LAUNCHPAD_POOL_PATH, LAUNCHPAD_SALES_PATH,
    LAUNCHPAD_TOKENS_PATH, PUBLISHED_MEMBA_DAO_PATH } from "./nftConfig"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadActionTerms", async (original) => ({ ...(await original<typeof import("./launchpadActionTerms")>()), readActionTerms: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))

const creator = `g1${"p".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const [low, high] = [packageAddress("gno.land/r/samcrew/creator/low"),
    packageAddress("gno.land/r/samcrew/creator/high")].sort()
const terms = { lane: "collection", currency: "ugnot", version: 2n, treasury, collectionFee: 40n,
    primaryFeeBPS: 100n, currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true } as const
const core = { creator, name: "Civic Art", symbol: "CIVIC", description: "Public art", image: "", banner: "", website: "",
    mode: "open" as const, revocable: false, maxSupply: 100n }
const staticDraft: CollectionCreationDraft = { ...core, metadataMode: "static", baseURI: "ipfs://collection/",
    royalties: [{ account: high, bps: 100n }, { account: low, bps: 400n }] }
const revealDraft: CollectionCreationDraft = { ...core, metadataMode: "reveal", placeholderURI: "ipfs://placeholder/a.json",
    committedBaseURIHash: "a".repeat(64), provenanceHash: "b".repeat(64), royalties: [] }

describe("permanent NFT creator variants", () => {
    beforeEach(() => vi.resetAllMocks())

    it("sorts bounded royalty terms and rejects duplicates, traps and Soulbound royalties", () => {
        expect(encodeCollectionRoyalties(staticDraft)).toEqual({ encoded: `${low}:400;${high}:100`, totalBPS: 500n,
            ordered: [{ account: low, bps: 400n }, { account: high, bps: 100n }] })
        expect(() => encodeCollectionRoyalties({ ...staticDraft, royalties: [{ account: low, bps: 600n }, { account: high, bps: 500n }] })).toThrow("10%")
        expect(() => encodeCollectionRoyalties({ ...staticDraft, royalties: [{ account: low, bps: 10n }, { account: low, bps: 10n }] })).toThrow("receiver")
        for (const path of [LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_CURATION_PATH, LAUNCHPAD_DROPS_PATH,
            LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH, LAUNCHPAD_POOL_PATH,
            LAUNCHPAD_SALES_PATH, LAUNCHPAD_TOKENS_PATH, LAUNCHPAD_CURATION_DAO_PATH, PUBLISHED_MEMBA_DAO_PATH]) {
            expect(() => encodeCollectionRoyalties({ ...staticDraft, royalties: [{ account: packageAddress(path), bps: 10n }] })).toThrow("receiver")
        }
        expect(() => encodeCollectionRoyalties({ ...staticDraft, mode: "soulbound", royalties: [{ account: low, bps: 10n }] })).toThrow("Soulbound")
    })

    it("selects the exact static and reveal MsgCall signatures", () => {
        const staticMsg = buildCreateCollectionVariantMsg(staticDraft, terms)
        expect(staticMsg.value).toMatchObject({ send: "40ugnot", func: "CreateCollectionWithRoyalties",
            args: ["Civic Art", "CIVIC", "Public art", "", "", "", "open", "false", "100", "ipfs://collection/",
                `${low}:400;${high}:100`, "ugnot", "2"] })
        expect(buildCreateCollectionVariantMsg({ ...staticDraft, royalties: [] }, terms).value.func).toBe("CreateCollection")
        const revealMsg = buildCreateCollectionVariantMsg(revealDraft, terms)
        expect(revealMsg.value).toMatchObject({ send: "40ugnot", func: "CreateCollectionWithReveal",
            args: ["Civic Art", "CIVIC", "Public art", "", "", "", "open", "false", "100", "ipfs://placeholder/a.json",
                "a".repeat(64), "b".repeat(64), "ugnot", "2"] })
        const revealWithRoyalties = buildCreateCollectionVariantMsg({ ...revealDraft, royalties: [{ account: low, bps: 500n }] }, terms)
        expect(revealWithRoyalties.value.func).toBe("CreateCollectionWithRevealAndRoyalties")
        expect(revealWithRoyalties.value.args).toContain(`${low}:500`)
        expect(() => buildCreateCollectionVariantMsg({ ...revealDraft, committedBaseURIHash: "bad" }, terms)).toThrow("commitments")
    })

    it("rechecks policy and verifies revealed collection and exact royalty split", async () => {
        vi.mocked(readActionTerms).mockResolvedValue(terms)
        vi.mocked(queryEval).mockResolvedValue("(4 int64)")
        const draft = { ...revealDraft, royalties: [{ account: low, bps: 500n }] }
        const request = createCollectionVariantRequest({ draft, terms, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(readActionTerms).mockResolvedValueOnce({ ...terms, collectionFee: 41n })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(queryEval).mockResolvedValue("(5 int64)")
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue({ ...draft, id: "C5", configVersion: 2n,
            metadataMode: "reveal_base", baseURI: "", baseURICommitment: "a".repeat(64), revealed: false,
            metadataFrozen: false, royaltyBPS: 500n, royalties: [{ account: low, bps: 500n }], minted: 0n, totalSupply: 0n } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ ...draft, id: "C5", configVersion: 2n,
            metadataMode: "reveal_base", baseURI: "", baseURICommitment: "a".repeat(64), revealed: false,
            metadataFrozen: false, royaltyBPS: 400n, royalties: [{ account: low, bps: 400n }], minted: 0n, totalSupply: 0n } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        expect(request.lines(undefined)).toContainEqual(["Creator royalty", "500 bps · fixed at creation"])
    })
})
