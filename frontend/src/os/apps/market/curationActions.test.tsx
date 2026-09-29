import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { EvidenceComposer } from "./curationActions"

const upload = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadCurationEvidence", () => ({ uploadCurationEvidence: upload }))

const account = `g1${"q".repeat(38)}`
const props = { collection: "C1", account, chainId: "gnoland-1", token: { userAddress: account, chainId: "gnoland-1" } as never,
    label: "Public application evidence", onPrepared: vi.fn() }
const verified = { text: "Public plan", cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e", sha256: "a".repeat(64) }

describe("public evidence composer", () => {
    beforeEach(() => { upload.mockReset(); props.onPrepared.mockReset() })

    it("requires explicit public-content acknowledgement and shows the verified commitment", async () => {
        upload.mockResolvedValue(verified)
        render(<EvidenceComposer {...props} />)
        fireEvent.change(screen.getByLabelText("Public application evidence"), { target: { value: "Public plan" } })
        expect(screen.getByRole("button", { name: "Pin and verify public text" })).toBeDisabled()
        fireEvent.click(screen.getByRole("checkbox"))
        fireEvent.click(screen.getByRole("button", { name: "Pin and verify public text" }))
        await waitFor(() => expect(props.onPrepared).toHaveBeenCalledWith(verified))
        expect(screen.getByRole("status")).toHaveTextContent("Public text verified")
    })

    it("ignores an in-flight pin after the author edits the draft", async () => {
        let resolve!: (value: typeof verified) => void
        upload.mockReturnValue(new Promise((done) => { resolve = done }))
        render(<EvidenceComposer {...props} />)
        const field = screen.getByLabelText("Public application evidence")
        fireEvent.change(field, { target: { value: "First draft" } })
        fireEvent.click(screen.getByRole("checkbox"))
        fireEvent.click(screen.getByRole("button", { name: "Pin and verify public text" }))
        fireEvent.change(field, { target: { value: "Revised draft" } })
        resolve(verified)
        await waitFor(() => expect(props.onPrepared).toHaveBeenLastCalledWith(null))
        expect(screen.queryByText("Public text verified")).toBeNull()
    })
})
