package service

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

const accessTestWallet = "g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const accessTestFounder = "g1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func accessRPCServer(t *testing.T, network string, view string, queryCount *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status" {
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"node_info": map[string]string{"network": network}}})
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/" {
			t.Errorf("unexpected RPC request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		*queryCount++
		var req abciQueryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		decoded, err := base64.StdEncoding.DecodeString(req.Params.Data)
		if err != nil || req.Params.Path != "vm/qeval" || string(decoded) != launchpadCurationPath+`.ReviewAccessJSON("C1","`+accessTestWallet+`")` {
			t.Errorf("unexpected role query: path=%q expr=%q err=%v", req.Params.Path, decoded, err)
		}
		typed := "(" + strconv.Quote(view) + " string)"
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"response": map[string]any{
			"ResponseBase": map[string]any{"Data": base64.StdEncoding.EncodeToString([]byte(typed)), "Error": nil},
		}}})
	}))
}

func accessRequest(h http.Handler) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/nft/curation-access?collection=C1", nil)
	r = r.WithContext(WithAuthAddress(r.Context(), accessTestWallet))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestLaunchpadCurationAccessBindsChainWalletAndCurrentRole(t *testing.T) {
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"2","status":"submitted","isFounder":false,"isManager":true,"canRead":true,"canReview":true}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	h := HandleLaunchpadCurationAccess(rpc.URL, "gnoland-1", true)
	w := accessRequest(h)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"canReview":true`) || queries != 1 {
		t.Fatalf("valid role snapshot: status=%d body=%s queries=%d", w.Code, w.Body.String(), queries)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("role snapshot must not be cached")
	}
	missing := httptest.NewRequest(http.MethodGet, "/api/nft/curation-access?collection=C1", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, missing)
	if w.Code != http.StatusUnauthorized || queries != 1 {
		t.Fatalf("missing identity: status=%d queries=%d", w.Code, queries)
	}
}

func TestLaunchpadCurationAccessFailsClosed(t *testing.T) {
	good := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"1","status":"submitted","isFounder":false,"isManager":true,"canRead":true,"canReview":true}`
	queries := 0
	rpc := accessRPCServer(t, "pearl-1", good, &queries)
	defer rpc.Close()
	w := accessRequest(HandleLaunchpadCurationAccess(rpc.URL, "gnoland-1", true))
	if w.Code != http.StatusServiceUnavailable || queries != 0 {
		t.Fatalf("wrong RPC chain must stop before query: status=%d queries=%d", w.Code, queries)
	}
	rpc2 := accessRPCServer(t, "gnoland-1", strings.Replace(good, `"canRead":true`, `"canRead":false`, 1), &queries)
	defer rpc2.Close()
	w = accessRequest(HandleLaunchpadCurationAccess(rpc2.URL, "gnoland-1", true))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("inconsistent role snapshot status %d", w.Code)
	}
	rpc3 := accessRPCServer(t, "gnoland-1", "null", &queries)
	defer rpc3.Close()
	w = accessRequest(HandleLaunchpadCurationAccess(rpc3.URL, "gnoland-1", true))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing application status %d", w.Code)
	}
	w = accessRequest(HandleLaunchpadCurationAccess(rpc3.URL, "gnoland-1", false))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled access status %d", w.Code)
	}
}
