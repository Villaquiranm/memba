import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import PublicCurationEvidence from "./evidence"

const fetchEvidence = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadCurationEvidence", () => ({ fetchCurationEvidence: fetchEvidence }))

const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const props = { label: "Application evidence", cid, sha256: "a".repeat(64) }

describe("public curation evidence panel", () => {
    beforeEach(() => fetchEvidence.mockReset())

    it("reveals only verified bytes after the reader requests them", async () => {
        fetchEvidence.mockResolvedValue({ cid, sha256: props.sha256, text: "Public launch plan" })
        render(<PublicCurationEvidence {...props} />)
        expect(screen.queryByText("Public launch plan")).toBeNull()
        expect(fetchEvidence).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole("button", { name: "Read verified text" }))
        expect(await screen.findByText("Public launch plan")).toBeInTheDocument()
        expect(screen.getByRole("status")).toHaveTextContent("Bytes match")
    })

})
