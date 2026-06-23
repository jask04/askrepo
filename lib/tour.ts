import { prisma } from "@/lib/db";
import { parseGithubUrl } from "@/lib/ingest";

export const DEFAULT_TOUR_REPO_URL =
  "https://github.com/jask04/realtime-notifications";

export type TourRepo = {
  id: string;
  url: string;
  owner: string;
  name: string;
  commitSha: string;
  status: string;
  chunkCount: number;
  fileCount: number;
};

export function getTourRepoUrl(): string {
  return process.env.TOUR_REPO_URL?.trim() || DEFAULT_TOUR_REPO_URL;
}

export function isTourConfigured(): boolean {
  return Boolean(process.env.TOUR_REPO_ID || getTourRepoUrl());
}

export async function findTourRepo(): Promise<TourRepo | null> {
  const select = {
    id: true,
    url: true,
    owner: true,
    name: true,
    commitSha: true,
    status: true,
    chunkCount: true,
    fileCount: true,
  } satisfies Record<keyof TourRepo, true>;

  const repoId = process.env.TOUR_REPO_ID?.trim();
  if (repoId) {
    const repo = await prisma.repo.findUnique({
      where: { id: repoId },
      select,
    });
    if (repo) return repo;
  }

  const parsed = parseGithubUrl(getTourRepoUrl());
  if (!parsed) return null;

  return prisma.repo.findUnique({
    where: { url: parsed.normalizedUrl },
    select,
  });
}
