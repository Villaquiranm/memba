import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GNO_CHAIN_ID } from "../../../lib/config"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_DROPS_PATH, LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH, NFT_COLLECTIONS_PATH, NFT_MARKETPLACE_V3_PATH } from "../../../lib/nftConfig"
import NftWindow from "./native"

const availability = vi.hoisted(() => ({ enabled: false, launchpad: false, ledger: false, market: false, launchpadMarket: false,
    drops: false, config: false, fees: false }))
const listCollections = vi.hoisted(() => vi.fn())
const getLaunchpadNftCapabilities = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadNft", () => ({ listLaunchpadNftCollections: listCollections }))
vi.mock("../../../lib/launchpadNftCapabilities", () => ({ getLaunchpadNftCapabilities }))
vi.mock("./create", () => ({ default: ({ available }: { available: boolean }) => <p>{available ? "native creator ready" : "native creator gated"}</p> }))
vi.mock("./studio", () => ({ default: ({ available }: { available: boolean }) => <p>{available ? "native studio ready" : "native studio gated"}</p> }))
vi.mock("./mint", () => ({ default: ({ available }: { available: boolean }) => <p>{available ? "native mint ready" : "native mint gated"}</p> }))
vi.mock("./manage", () => ({ default: ({ available }: { available: boolean }) => <p>{available ? "native token management ready" : "native token management gated"}</p> }))
vi.mock("../../../lib/config", async (original) => ({
    ...(await original<typeof import("../../../lib/config")>()),
    isNftEnabled: () => availability.enabled,
    isRealmValidOn: (_network: string, path: string) => path === NFT_COLLECTIONS_PATH ? availability.launchpad : path === LAUNCHPAD_NFT_PATH ? availability.ledger :
        path === NFT_MARKETPLACE_V3_PATH ? availability.market : path === LAUNCHPAD_MARKET_PATH ? availability.launchpadMarket :
            path === LAUNCHPAD_DROPS_PATH ? availability.drops : path === LAUNCHPAD_CONFIG_PATH ? availability.config :
                path === LAUNCHPAD_FEES_PATH ? availability.fees : false,
}))
const session = (isTestnet: boolean) => ({ network: { key: isTestnet ? "testnet12" : "mainnet", isTestnet } }) as never
const base = { query: undefined, close: () => {}, toast: () => {}, fallback: <p>classic page</p> }

describe("NFT window", () => {
    beforeEach(() => { availability.enabled = false; availability.launchpad = false; availability.ledger = false; availability.market = false;
        availability.launchpadMarket = false; availability.drops = false; availability.config = false; availability.fees = false;
        listCollections.mockReset(); getLaunchpadNftCapabilities.mockReset() })

    it("on mainnet, separates implemented screens, absent registry and disabled build flag", () => {
        const openApp = vi.fn()
        render(<NftWindow {...base} section={null} session={session(false)} open={vi.fn()} openApp={openApp} />)
        expect(screen.getByRole("note")).toHaveTextContent("screens are implemented in Memba")
        expect(screen.getByRole("note")).toHaveTextContent(`registry is not deployed on ${GNO_CHAIN_ID}`)
        expect(screen.getByRole("note")).toHaveTextContent("disabled in this build")
        expect(screen.queryByText("classic page")).toBeNull()
        expect(screen.queryByText(/Trade NFTs and hire/)).toBeNull()
        fireEvent.click(screen.getByRole("button", { name: /Open Market/ }))
        expect(openApp).toHaveBeenCalledWith("market")
    })

    it("elsewhere, offers NFT actions only when the flag and relevant realms are available", () => {
        availability.enabled = true
        availability.launchpad = true
        availability.market = true
        const open = vi.fn()
        render(<NftWindow {...base} section={null} session={session(true)} open={open} openApp={vi.fn()} />)
        expect(screen.queryByText("classic page")).toBeNull()

        fireEvent.click(screen.getByRole("button", { name: /Browse NFTs/ }))
        expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ target: { kind: "app", app: "market", section: "nfts" } }))

        fireEvent.click(screen.getByRole("button", { name: /Create a collection/ }))
        expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ target: { kind: "app", app: "nft", section: "create" } }))

        fireEvent.click(screen.getByRole("button", { name: /Your studio/ }))
        expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ target: { kind: "app", app: "nft", section: "studio" } }))
    })

    it("keeps a deployed registry unavailable when the NFT build flag is off", () => {
        availability.launchpad = true
        render(<NftWindow {...base} section={null} session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("disabled in this build")
        expect(screen.queryByRole("button", { name: /Create a collection/ })).toBeNull()
    })

    it("does not advertise NFT trading when only the collection registry is available", () => {
        availability.enabled = true
        availability.launchpad = true
        render(<NftWindow {...base} section={null} session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.queryByRole("button", { name: /Browse NFTs/ })).toBeNull()
        expect(screen.getByRole("button", { name: /Create a collection/ })).toBeInTheDocument()
    })

    it("shows real ledger collections and SoulBound rules without offering legacy creation", async () => {
        availability.enabled = true
        availability.ledger = true
        listCollections.mockResolvedValue([{ id: "C1", name: "Founders", symbol: "FND", creator: "g1creator", mode: "soulbound", revocable: true, totalSupply: 1n, minted: 2n, maxSupply: 100n,
            metadataMode: "reveal_base", revealed: false, metadataFrozen: false, placeholderURI: "ipfs://placeholder/placeholder.json", baseURICommitment: "a".repeat(64), provenanceHash: "b".repeat(64), royaltyBPS: 0n, royalties: [] }])
        getLaunchpadNftCapabilities.mockResolvedValue({ transferable: false, approvable: false, issuerRevoke: true, recipientClaimRequired: true, nativeMarketModeEligible: false, royaltyScope: "none", canReveal: true, metadataFrozen: false })
        render(<NftWindow {...base} section={null} session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.queryByRole("button", { name: /Create a collection/ })).toBeNull()
        expect(screen.getByText(/Trading for these collections is not available yet/)).toBeInTheDocument()
        expect(await screen.findByText("Founders")).toBeInTheDocument()
        expect(screen.getByText("SoulBound")).toBeInTheDocument()
        expect(screen.getByText("Creator revocable")).toBeInTheDocument()
        expect(screen.getByText(/Metadata: hidden behind a placeholder · not frozen/)).toBeInTheDocument()
        expect(screen.getByText(/Royalty terms: 0 bps · none recorded/)).toBeInTheDocument()
        fireEvent.click(screen.getByText("Collection terms"))
        expect(screen.getByText(/File contents and provenance have not been verified by Memba/)).toBeInTheDocument()
        expect(screen.getByText("b".repeat(64))).toBeInTheDocument()
        expect(getLaunchpadNftCapabilities).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole("button", { name: "Check current rights" }))
        expect(await screen.findByText(/Transfer: blocked · Approvals: blocked/)).toBeInTheDocument()
        expect(screen.getByText(/Recipient claim: required/)).toBeInTheDocument()
        expect(getLaunchpadNftCapabilities).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: "C1" }))
        expect(listCollections).toHaveBeenCalledWith(expect.any(String), 0, 20)
    })

    it("reports a ledger read failure instead of showing an empty collection state", async () => {
        availability.enabled = true
        availability.ledger = true
        listCollections.mockRejectedValue(new Error("RPC down"))
        render(<NftWindow {...base} section={null} session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        await waitFor(() => expect(screen.getByText("Could not read Launchpad collections from this network.")).toBeInTheDocument())
        expect(screen.queryByText("No Launchpad collections have been created yet.")).toBeNull()
    })

    it("opens native Launchpad sale records only after the market realm is allowlisted", () => {
        availability.enabled = true
        availability.ledger = true
        availability.launchpadMarket = true
        listCollections.mockResolvedValue([])
        const open = vi.fn()
        render(<NftWindow {...base} section={null} session={session(true)} open={open} openApp={vi.fn()} />)
        fireEvent.click(screen.getByRole("button", { name: /Launchpad sale records/ }))
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "app", app: "market", section: "launchpad" } }))
    })

    it("routes Launchpad creation to the native form only behind the ledger and realm gates", () => {
        availability.enabled = true
        availability.ledger = true
        const view = render(<NftWindow {...base} section="create" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native creator gated")).toBeInTheDocument()
        availability.drops = true; availability.config = true; availability.fees = true
        view.rerender(<NftWindow {...base} section="create" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native creator ready")).toBeInTheDocument()
    })

    it("routes the Launchpad Creator Studio only behind the ledger and realm gates", () => {
        availability.enabled = true
        availability.ledger = true
        const view = render(<NftWindow {...base} section="studio" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native studio gated")).toBeInTheDocument()
        availability.drops = true; availability.config = true; availability.fees = true
        view.rerender(<NftWindow {...base} section="studio" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native studio ready")).toBeInTheDocument()
    })

    it("routes native primary minting behind the ledger and realm gates", () => {
        availability.enabled = true
        availability.ledger = true
        const view = render(<NftWindow {...base} section="mint" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native mint gated")).toBeInTheDocument()
        availability.drops = true; availability.config = true; availability.fees = true
        view.rerender(<NftWindow {...base} section="mint" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native mint ready")).toBeInTheDocument()
    })

    it("routes holder actions with the NFT ledger even if the drop realms are absent", () => {
        availability.enabled = true
        availability.ledger = true
        render(<NftWindow {...base} section="manage" session={session(true)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("native token management ready")).toBeInTheDocument()
    })

    it("renders the fallback for every section other than the home, on any network", () => {
        render(<NftWindow {...base} section="create" session={session(false)} open={vi.fn()} openApp={vi.fn()} />)
        expect(screen.getByText("classic page")).toBeInTheDocument()
        expect(screen.queryByRole("note")).toBeNull()
    })
})
