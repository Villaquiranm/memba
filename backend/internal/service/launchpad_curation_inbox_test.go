package service

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	dbpkg "github.com/samouraiworld/memba/backend/internal/db"
)

func curationInboxDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := dbpkg.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := dbpkg.Migrate(database); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func curationInboxRequest(h http.Handler, method, clientID, message string) *httptest.ResponseRecorder {
	path := "/api/nft/curation-thread?collection=C1"
	var body *strings.Reader
	if method == http.MethodPost {
		payload, _ := json.Marshal(curationSendRequest{ClientID: clientID, Text: message})
		body = strings.NewReader(string(payload))
	} else {
		body = strings.NewReader("")
	}
	r := httptest.NewRequest(method, path, body)
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(WithAuthAddress(r.Context(), accessTestWallet))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestCurationInboxEncryptsAndRechecksEveryRequest(t *testing.T) {
	database := curationInboxDB(t)
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"2","status":"submitted","isFounder":false,"isManager":true,"canRead":true,"canReview":true}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	key := bytes.Repeat([]byte{0x42}, 32)
	h, err := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpc.URL, ChainID: "gnoland-1", Key: key,
		AllowSend: func(string) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	clientID := strings.Repeat("a", 32)
	w := curationInboxRequest(h, http.MethodPost, clientID, "Private launch details")
	if w.Code != http.StatusCreated || !strings.Contains(w.Body.String(), "Private launch details") {
		t.Fatalf("send status=%d body=%s", w.Code, w.Body.String())
	}
	var first curationMessage
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	var encrypted []byte
	if err := database.QueryRow(`SELECT ciphertext FROM launchpad_curation_messages WHERE id=?`, first.ID).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte("Private launch details")) {
		t.Fatal("private text was stored in plaintext")
	}
	w = curationInboxRequest(h, http.MethodPost, clientID, "Private launch details")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), first.ID) {
		t.Fatalf("idempotent retry status=%d body=%s", w.Code, w.Body.String())
	}
	w = curationInboxRequest(h, http.MethodPost, clientID, "Different details")
	if w.Code != http.StatusConflict {
		t.Fatalf("reused id with different text status=%d", w.Code)
	}
	w = curationInboxRequest(h, http.MethodPost, strings.Repeat("b", 32), strings.Repeat("x", 9000))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversized private message status=%d", w.Code)
	}
	w = curationInboxRequest(h, http.MethodGet, "", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Private launch details") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("read status=%d body=%s", w.Code, w.Body.String())
	}
	if queries != 5 {
		t.Fatalf("every send/retry/read must recheck current chain access, queries=%d", queries)
	}
	var count int
	if err := database.QueryRow(`SELECT COUNT(*) FROM launchpad_curation_messages`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("idempotent store count=%d err=%v", count, err)
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM launchpad_curation_message_audit`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("send/read audit count=%d err=%v", count, err)
	}
	if _, err := database.Exec(`UPDATE launchpad_curation_messages SET ciphertext=x'00' WHERE id=?`, first.ID); err != nil {
		t.Fatal(err)
	}
	w = curationInboxRequest(h, http.MethodGet, "", "")
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "Private launch details") {
		t.Fatalf("tampered ciphertext must fail closed, status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCurationInboxRejectsLostRoleWrongChainAndInvalidKey(t *testing.T) {
	database := curationInboxDB(t)
	if _, err := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: "https://rpc.example", ChainID: "gnoland-1",
		Key: []byte("short"), AllowSend: func(string) bool { return true }}); err == nil {
		t.Fatal("missing encryption key must disable inbox")
	}
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"2","status":"submitted","isFounder":false,"isManager":false,"canRead":false,"canReview":false}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	h, err := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpc.URL, ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x24}, 32), AllowSend: func(string) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	w := curationInboxRequest(h, http.MethodGet, "", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("removed manager read status=%d", w.Code)
	}
	w = curationInboxRequest(h, http.MethodPost, strings.Repeat("b", 32), "Hello")
	if w.Code != http.StatusForbidden {
		t.Fatalf("removed manager send status=%d", w.Code)
	}
	rpcWrong := accessRPCServer(t, "pearl-1", view, &queries)
	defer rpcWrong.Close()
	hWrong, _ := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpcWrong.URL, ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x24}, 32), AllowSend: func(string) bool { return true }})
	w = curationInboxRequest(hWrong, http.MethodGet, "", "")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("wrong RPC chain status=%d", w.Code)
	}
	hLimited, _ := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpc.URL, ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x24}, 32), AllowSend: func(string) bool { return false }})
	w = curationInboxRequest(hLimited, http.MethodPost, strings.Repeat("b", 32), "Hello")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("per-wallet send cap status=%d", w.Code)
	}
}
