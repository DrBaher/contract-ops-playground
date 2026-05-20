# Playground image: the suite CLIs the playgrounds shell out to, plus the server.
#   Node CLIs: draft, compare, docx2pdf, sign   |   Python: template-vault, nda-review
#   docx2pdf needs a PDF backend → LibreOffice (headless).
#   sign uses node:sqlite → Node 22+ required.
# NOTE: this image is large because of LibreOffice. For docx2pdf you can instead
# point COP_DOCX2PDF at a Gotenberg sidecar; see README.
FROM node:22-bookworm-slim

# PDF backend for docx2pdf + a base font set; git for the template-vault
# explorer (template-vault is a git-backed vault and `demo` makes commits).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer fonts-liberation python3 pipx git \
  && rm -rf /var/lib/apt/lists/*

# Identity for the vault seed's git commits (read-only requests don't commit).
ENV GIT_AUTHOR_NAME=playground GIT_AUTHOR_EMAIL=playground@local \
    GIT_COMMITTER_NAME=playground GIT_COMMITTER_EMAIL=playground@local

# Node CLIs (PIN exact versions for a real deploy — don't float to latest).
RUN npm i -g @drbaher/draft-cli@latest compare-cli@latest docx2pdf-cli@latest @drbaher/sign-cli@latest \
  && npm cache clean --force

# Python CLIs (template-vault explorer + nda-review).
ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin
RUN pipx install template-vault-cli && pipx install nda-review-cli

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY assets ./assets

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080

# Run unprivileged.
USER node

CMD ["node", "src/server.mjs"]
