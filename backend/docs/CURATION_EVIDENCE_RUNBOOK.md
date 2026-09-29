# Public curation evidence upload

The proposed curation realm stores an IPFS CID and SHA-256 digest for each
founder application and manager review reason. The public reader fetches the
CID through approved gateways and displays text only when its exact bytes
match the on-chain digest. This content can be copied and may remain public
after a later change of status. Do not put private founder correspondence,
identity documents or personal data in public evidence.

`POST /api/nft/curation-evidence/upload?collection=C1` is off by default. It accepts
`text/plain; charset=utf-8`, at most 16 KiB. A signed wallet token for the
backend's exact `GNO_CHAIN_ID` is required. A fixed Lighthouse endpoint pins
the text only after the service verifies the active manager/founder permission,
or the NFT creator for an initial application, against the configured current
chain RPC. The response contains `cid` and `sha256`. No application or review
transaction is sent by this endpoint.

Before enabling `LAUNCHPAD_CURATION_EVIDENCE_UPLOAD_ENABLED=1`, verify the
unpublished curation ABI with the matching Memba reader, the exact chain,
the public-content policy, `LIGHTHOUSE_API_KEY`, per-IP and per-wallet quotas,
and a real pin-and-fetch rehearsal. The browser must fetch and hash the CID
before asking the wallet to sign `Apply` or `Review`. If retrieval fails,
keep the action unavailable. Pinning availability and backup procedures need
an owner before production activation.
