package indexer

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeLaunchpadSource struct {
	latest int64
	hashes map[int64]string
	events map[int64][]GnoEvent
	chain  string
}

func (f *fakeLaunchpadSource) LatestHeight(_ context.Context, expected string) (int64, error) {
	if f.chain != expected {
		return 0, fmt.Errorf("wrong chain")
	}
	return f.latest, nil
}

func (f *fakeLaunchpadSource) BlockHash(_ context.Context, expected string, height int64) (string, error) {
	if f.chain != expected {
		return "", fmt.Errorf("wrong chain")
	}
	return f.hashes[height], nil
}

func (f *fakeLaunchpadSource) BlockEvents(_ context.Context, height int64) ([]GnoEvent, error) {
	return f.events[height], nil
}

func TestLaunchpadTailerReorgAndAtomicBlock(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	cfg := LaunchpadTailerConfig{ChainID: "gnoland-1", StartBlock: 10, Confirmations: 1}
	mint := ownershipEvent("LaunchpadNFTMinted", 10, 0, map[string]string{
		"collection": "C1", "number": "1", "recipient": ownerA,
	})
	transfer := ownershipEvent("LaunchpadNFTTransferred", 11, 0, map[string]string{
		"collection": "C1", "number": "1", "from": ownerA, "to": ownerB, "actor": ownerA,
	})
	src := &fakeLaunchpadSource{
		chain: "gnoland-1", latest: 13,
		hashes: map[int64]string{10: "H10", 11: "H11", 12: "H12"},
		events: map[int64][]GnoEvent{10: {mint}, 11: {transfer}},
	}
	if err := launchpadTailOnce(ctx, database, cfg, src); err != nil {
		t.Fatal(err)
	}
	got, err := GetLaunchpadTokenOwnership(ctx, database, cfg.ChainID, "C1", 1)
	if err != nil || got.Owner != ownerB {
		t.Fatalf("initial owner: %+v, %v", got, err)
	}
	// Replace two confirmed blocks. The changed transfer has a different
	// recipient, so a stale projection would be visible immediately.
	src.hashes[11], src.hashes[12] = "NEW11", "NEW12"
	src.events[11] = []GnoEvent{ownershipEvent("LaunchpadNFTTransferred", 11, 0, map[string]string{
		"collection": "C1", "number": "1", "from": ownerA, "to": issuer, "actor": ownerA,
	})}
	if err := launchpadTailOnce(ctx, database, cfg, src); err != nil {
		t.Fatalf("reorg replay: %v", err)
	}
	got, err = GetLaunchpadTokenOwnership(ctx, database, cfg.ChainID, "C1", 1)
	if err != nil || got.Owner != issuer {
		t.Fatalf("owner after reorg: %+v, %v", got, err)
	}
	// A bad second event in a block must not expose the first event or
	// advance the cursor. Fixing the event then permits a clean retry.
	src.latest = 14
	src.hashes[13] = "H13"
	src.events[13] = []GnoEvent{
		ownershipEvent("LaunchpadNFTMinted", 13, 0, map[string]string{
			"collection": "C2", "number": "1", "recipient": ownerB,
		}),
		ownershipEvent("LaunchpadNFTTransferred", 13, 1, map[string]string{
			"collection": "C2", "number": "1", "from": ownerA, "to": issuer, "actor": ownerA,
		}),
	}
	if err := launchpadTailOnce(ctx, database, cfg, src); err == nil {
		t.Fatal("invalid block accepted")
	}
	if _, err := GetLaunchpadTokenOwnership(ctx, database, cfg.ChainID, "C2", 1); err == nil {
		t.Fatal("partial block exposed a minted owner")
	}
	src.events[13] = src.events[13][:1]
	if err := launchpadTailOnce(ctx, database, cfg, src); err != nil {
		t.Fatalf("block retry: %v", err)
	}
	got, err = GetLaunchpadTokenOwnership(ctx, database, cfg.ChainID, "C2", 1)
	if err != nil || got.Owner != ownerB {
		t.Fatalf("owner after retry: %+v, %v", got, err)
	}
}

func TestLaunchpadHTTPSourceRequiresStatusAndBlockChain(t *testing.T) {
	chain := "gnoland-1"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/status":
			_, _ = fmt.Fprintf(w, `{"result":{"node_info":{"network":%q},"sync_info":{"latest_block_height":"20"}}}`, chain)
		case "/block":
			_, _ = fmt.Fprintf(w, `{"result":{"block_meta":{"header":{"chain_id":%q},"block_id":{"hash":"HASH"}}}}`, chain)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	src := launchpadHTTPSource{client: server.Client(), url: server.URL}
	if h, err := src.LatestHeight(context.Background(), "gnoland-1"); err != nil || h != 20 {
		t.Fatalf("status: %d, %v", h, err)
	}
	if hash, err := src.BlockHash(context.Background(), "gnoland-1", 19); err != nil || hash != "HASH" {
		t.Fatalf("block: %q, %v", hash, err)
	}
	chain = "pearl-1"
	if _, err := src.LatestHeight(context.Background(), "gnoland-1"); err == nil {
		t.Fatal("wrong status chain accepted")
	}
	if _, err := src.BlockHash(context.Background(), "gnoland-1", 19); err == nil {
		t.Fatal("wrong block chain accepted")
	}
}
