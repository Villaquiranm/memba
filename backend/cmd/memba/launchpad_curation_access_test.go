package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samouraiworld/memba/backend/internal/service"
)

type curationIdentityStub struct {
	address string
	chain   string
	err     error
}

func (s curationIdentityStub) ValidateRESTTokenIdentity(string) (string, string, error) {
	return s.address, s.chain, s.err
}

func TestCurationAccessMiddlewareRequiresExactSignedChain(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if wallet, ok := service.AuthAddressFrom(r.Context()); !ok || wallet != "g1wallet" {
			t.Fatalf("authenticated wallet = %q, %t", wallet, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	for _, tc := range []struct {
		name string
		stub curationIdentityStub
		want int
	}{
		{"matching chain", curationIdentityStub{address: "g1wallet", chain: "gnoland-1"}, http.StatusNoContent},
		{"other accepted chain", curationIdentityStub{address: "g1wallet", chain: "pearl-1"}, http.StatusUnauthorized},
		{"legacy chainless", curationIdentityStub{address: "g1wallet"}, http.StatusUnauthorized},
		{"invalid token", curationIdentityStub{err: errors.New("invalid")}, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called = false
			h := launchpadCurationAccessHandler(tc.stub, "gnoland-1", next)
			r := httptest.NewRequest(http.MethodGet, "/api/nft/curation-access?collection=C1", nil)
			r.Header.Set("Authorization", "Bearer signed-token")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want || called != (tc.want == http.StatusNoContent) {
				t.Fatalf("status=%d nextCalled=%t", w.Code, called)
			}
		})
	}
}
