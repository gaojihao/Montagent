# Montagent (TypeScript) — Makefile
# Target NAMES are kept 1:1 with the Python version; only the internals change.

OM := ./bin/montagent

.PHONY: setup install install-dev install-gpu test test-contracts lint clean guard \
        preflight demo demo-list hyperframes-doctor hyperframes-warm

# ---- One-command setup ----
setup:
	@echo "==> Installing dependencies (pnpm workspace: app + remotion-composer)..."
	pnpm install
	@echo ""
	@echo "==> Creating .env from .env.example (if missing)..."
	@[ -f .env ] || { [ -f .env.example ] && cp .env.example .env && echo "    Created .env — add your API keys there." || echo "    No .env.example; skipping."; }
	@echo ""
	@echo "Done! Optional: add API keys to .env to unlock cloud providers."
	@echo "  GPU/PyTorch local inference is intentionally dropped in the TS port — use cloud providers."

# ---- Individual installs ----
install:
	pnpm install

install-dev:
	pnpm install

install-gpu:
	@echo "GPU/PyTorch local inference is disabled in the TypeScript port."
	@echo "Use cloud providers instead (set the relevant API keys in .env)."

# ---- Testing ----
test:
	pnpm run test

test-contracts:
	pnpm run test:contracts

# ---- Utilities ----
preflight:
	$(OM) preflight

hyperframes-doctor:
	$(OM) hyperframes doctor

hyperframes-warm:
	@echo "==> Refreshing the HyperFrames npx cache to latest..."
	npx --yes --prefer-online hyperframes --version
	@echo "==> Cache warm complete."

demo:
	@echo "==> Rendering zero-key demo videos (no API keys needed)..."
	$(OM) demo

demo-list:
	$(OM) demo --list

lint:
	pnpm run lint
	$(MAKE) guard

# CI guard: fail if any instruction file still embeds `python -c "from tools..."`.
guard:
	node scripts/codemod-skill-commands.mjs --check

clean:
	rm -rf dist node_modules/.cache .remotion
