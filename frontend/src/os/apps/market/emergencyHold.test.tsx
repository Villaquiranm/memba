import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { bech32Encode } from "../../../lib/dao/realmAddress"
import EmergencyHoldDesk from "./emergencyHold"

const getCollection = vi.hoisted(() => vi.fn())
const getApplication = vi.hoisted(() => vi.fn())
const getReceipt = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn())
const readAccess = vi.hoisted(() => vi.fn())
const upload = vi.hoisted(() => vi.fn())
const fetchEvidence = vi.hoisted(() => vi.fn())
const editorial = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadNft", () => ({ getLaunchpadNftCollection: getCollection }))
vi.mock("../../../lib/launchpadCuration", () => ({ getCurationApplication: getApplication,
    getCollectionCuration: getReceipt, getCurationState: getState }))
vi.mock("../../../lib/launchpadCurationInbox", () => ({ readCurationEditorialAccess: readAccess }))
vi.mock("../../../lib/launchpadCurationEvidence", () => ({ uploadCurationEvidence: upload, fetchCurationEvidence: fetchEvidence }))
vi.mock("../../../lib/launchpadCurationEditorial", () => ({ editorialScope: (_chain: string, id: string, _who: string, action: string) => ({
    chainId: "gnoland-1", realmPath: "gno.land/r/samcrew/launchpad/curation/v1", caller: "manager", operation: `${action}:${id}` }),
    editorialRequest: editorial }))
vi.mock("../../../lib/grc20", async (original) => ({ ...(await original<typeof import("../../../lib/grc20")>()),
    networkGasPrice: vi.fn(async () => ({ gas: 1000, ugnot: 1 })) }))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const founder = addr(1), manager = addr(2), other = addr(3), admin = addr(4)
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const receipt = { collection: "C1", featured: false, hidden: false, feature: null, hold: null, verification: null }
const token = { userAddress: manager, chainId: "gnoland-1", nonce: "1" }
const session = { status: "member", address: manager, network: { chainId: "gnoland-1" }, layout: { auth: { token } } } as never
const props = { rpcUrl: "rpc", session, toast: vi.fn(), onChanged: vi.fn() }

describe("urgent discovery hold desk", () => {
    beforeEach(() => {
        getCollection.mockReset().mockResolvedValue({ id: "C1", creator: founder, name: "Collection" })
        getApplication.mockReset().mockResolvedValue(null)
        getReceipt.mockReset().mockResolvedValue(receipt)
        getState.mockReset().mockResolvedValue({ admin, governed: true, activeManagers: 2 })
        readAccess.mockReset().mockResolvedValue({ collection: "C1", account: manager, creator: founder, isManager: true })
        upload.mockReset().mockResolvedValue({ cid, sha256: "a".repeat(64), text: "Public emergency reason" })
        fetchEvidence.mockReset().mockResolvedValue({ cid, sha256: "b".repeat(64), text: "Existing public reason" })
        editorial.mockReset().mockReturnValue({ title: "Hold" })
        sign.mockReset()
        localStorage.clear()
    })

    async function checkCollection() {
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.click(screen.getByRole("button", { name: "Check collection" }))
        await screen.findByText("No founder application")
    }

    it("lets an appointed manager prepare a reason for a collection without an application", async () => {
        render(<EmergencyHoldDesk {...props} />)
        await checkCollection()
        fireEvent.change(screen.getByLabelText("Public emergency hold reason"), { target: { value: "Public emergency reason" } })
        fireEvent.click(screen.getByRole("checkbox"))
        fireEvent.click(screen.getByRole("button", { name: "Pin and verify public text" }))
        await waitFor(() => expect(screen.getByRole("button", { name: "Review discovery hold in wallet" })).toBeEnabled())
        fireEvent.click(screen.getByRole("button", { name: "Review discovery hold in wallet" }))
        await waitFor(() => expect(sign).toHaveBeenCalledWith({ title: "Hold" }))
        expect(editorial).toHaveBeenCalledWith(expect.objectContaining({ action: "hide-start", application: null, caller: manager }))
    })

    it("requires verified existing reason text before a second manager confirms", async () => {
        getReceipt.mockResolvedValue({ ...receipt, hidden: true, hold: { actor: other, confirmer: "",
            reasonHash: "b".repeat(64), reasonCID: cid, until: String(Math.floor(Date.now() / 1000) + 86_400) } })
        render(<EmergencyHoldDesk {...props} />)
        await checkCollection()
        expect(screen.getByRole("button", { name: "Review hold confirmation in wallet" })).toBeDisabled()
        fireEvent.click(screen.getByRole("button", { name: "Read verified text" }))
        await waitFor(() => expect(screen.getByRole("button", { name: "Review hold confirmation in wallet" })).toBeEnabled())
        fireEvent.click(screen.getByRole("button", { name: "Review hold confirmation in wallet" }))
        await waitFor(() => expect(editorial).toHaveBeenCalledWith(expect.objectContaining({ action: "hide-confirm", application: null })))
    })

    it("keeps controls unavailable for a revoked manager", async () => {
        readAccess.mockResolvedValue({ collection: "C1", account: manager, creator: founder, isManager: false })
        render(<EmergencyHoldDesk {...props} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.click(screen.getByRole("button", { name: "Check collection" }))
        await screen.findByText(/not an active, unconflicted manager/)
        expect(screen.queryByRole("button", { name: "Review discovery hold in wallet" })).toBeNull()
        expect(screen.getByText(/not an active, unconflicted manager/)).toBeInTheDocument()
    })

    it("hides the checked collection's controls as soon as the lookup ID changes", async () => {
        render(<EmergencyHoldDesk {...props} />)
        await checkCollection()
        expect(screen.getByRole("button", { name: "Review discovery hold in wallet" })).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C2" } })
        expect(screen.queryByRole("button", { name: "Review discovery hold in wallet" })).toBeNull()
    })

    it("requires a fresh lookup after editing an ID even when the manager types the old ID back", async () => {
        render(<EmergencyHoldDesk {...props} />)
        await checkCollection()
        expect(getCollection).toHaveBeenCalledTimes(1)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C2" } })
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        expect(screen.queryByRole("button", { name: "Review discovery hold in wallet" })).toBeNull()
        fireEvent.click(screen.getByRole("button", { name: "Check collection" }))
        await screen.findByText("No founder application")
        expect(getCollection).toHaveBeenCalledTimes(2)
    })
})
