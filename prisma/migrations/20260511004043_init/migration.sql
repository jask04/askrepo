-- pgvector extension must be created before any vector columns are
-- referenced. Done here rather than in a separate migration so the
-- schema is bootstrappable from an empty database in a single step.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RepoStatus" AS ENUM ('PENDING', 'INGESTING', 'EMBEDDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" "RepoStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector(768),
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Repo_url_key" ON "Repo"("url");

-- CreateIndex
CREATE INDEX "Document_repoId_path_idx" ON "Document"("repoId", "path");

-- HNSW index for approximate nearest-neighbour search over Gemini's
-- 768-dim embeddings. Cosine similarity matches Prisma's <=> operator
-- used in lib/retrieve.ts on Day 5.
CREATE INDEX "Document_embedding_hnsw_idx" ON "Document"
    USING hnsw (embedding vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
