import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { bech32Encode } from "../../../lib/dao/realmAddress"
import { ManagerEditorialDesk } from "./curationActions"

const readAccess = vi.hoisted(() => vi.fn())
const getCollection = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
const editorial = vi.hoisted(() => vi.fn())
const upload = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadCurationInbox", () => ({ readCurationAccess: readAccess }))
vi.mock("../../../lib/launchpadNft", () => ({ getLaunchpadNftCollection: getCollection }))
vi.mock("../../../lib/launchpadCuration", () => ({ getCurationState: getState }))
vi.mock("../../../lib/launchpadCurationEditorial", () => ({ editorialScope: (_chain: string, id: string, _who: string, action: string) => ({
    chainId: "gnoland-1", realmPath: "gno.land/r/samcrew/launchpad/curation/v1", caller: "manager", operation: `${action}:${id}` }),
    editorialRequest: editorial }))
vi.mock("../../../lib/launchpadCurationEvidence", () => ({ uploadCurationEvidence: upload }))
vi.mock("../../../lib/grc20", async (original) => ({ ...(await original<typeof import("../../../lib/grc20")>()),
    networkGasPrice: vi.fn(async () => ({ gas: 1000, ugnot: 1 })) }))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const founder = addr(1), proposer = addr(2), manager = addr(3), admin = addr(4)
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const application = { collection: "C1", founder, statementHash: "a".repeat(64), statementCID: cid,
    revision: "1", status: "recommended", reviewer: proposer, reasonHash: "b".repeat(64), reasonCID: cid, updatedAt: "100" }
const receipt = { collection: "C1", featured: false, hidden: false, feature: { proposer, approver: "",
    reasonHash: "c".repeat(64), reasonCID: cid, until: String(Math.floor(Date.now() / 1000) + 86_400), approvedAt: "0" },
hold: null, verification: null }
const token = { userAddress: manager, chainId: "gnoland-1", nonce: "1" }
const session = { status: "member", address: manager, network: { chainId: "gnoland-1" }, layout: { auth: { token } } } as never
const props = { application, receipt, rpcUrl: "rpc", session, toast: vi.fn(), onChanged: vi.fn() } as never

describe("manager editorial desk", () => {
    beforeEach(() => {
        readAccess.mockReset().mockResolvedValue({ isManager: true, revision: "1" })
        getCollection.mockReset().mockResolvedValue({ id: "C1", creator: founder, name: "Collection" })
        getState.mockReset().mockResolvedValue({ admin, governed: true, activeManagers: 2 })
        editorial.mockReset().mockReturnValue({ title: "Approve" })
        sign.mockReset()
        upload.mockReset()
        localStorage.clear()
    })

    it("shows approval after review and prepares one wallet request", async () => {
        render(<ManagerEditorialDesk {...props} />)
        expect(await screen.findByRole("heading", { name: "Editorial controls" })).toBeInTheDocument()
        expect(screen.getByRole("option", { name: "Approve feature slot" })).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Review editorial action in wallet" }))
        await waitFor(() => expect(sign).toHaveBeenCalledWith({ title: "Approve" }))
        expect(editorial).toHaveBeenCalledWith(expect.objectContaining({ action: "feature-approve", caller: manager }))
    })

    it("hides controls after role revocation", async () => {
        readAccess.mockResolvedValue({ isManager: false, revision: "1" })
        render(<ManagerEditorialDesk {...props} />)
        await waitFor(() => expect(readAccess).toHaveBeenCalled())
        expect(screen.queryByRole("heading", { name: "Editorial controls" })).toBeNull()
    })

    it("does not reuse a pinned feature reason when the receipt changes to a hold action", async () => {
        upload.mockResolvedValue({ text: "Public feature rationale", cid, sha256: "d".repeat(64) })
        const initial = { ...receipt, feature: null, hold: { actor: proposer, confirmer: proposer,
            reasonHash: "e".repeat(64), reasonCID: cid, until: "1" } }
        const view = render(<ManagerEditorialDesk {...props} receipt={initial} />)
        expect(await screen.findByRole("option", { name: "Propose feature slot" })).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Public editorial reason"), { target: { value: "Public feature rationale" } })
        fireEvent.click(screen.getByRole("checkbox"))
        fireEvent.click(screen.getByRole("button", { name: "Pin and verify public text" }))
        await waitFor(() => expect(screen.getByRole("button", { name: "Review editorial action in wallet" })).toBeEnabled())
        view.rerender(<ManagerEditorialDesk {...props} receipt={{ ...receipt, feature: { ...receipt.feature,
            approver: manager, approvedAt: "100" } }} />)
        expect(screen.getByRole("option", { name: "Start 24-hour discovery hold" })).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Review editorial action in wallet" })).toBeDisabled()
    })
})
