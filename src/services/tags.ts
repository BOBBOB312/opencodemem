import { homedir } from "os";
import { join, basename, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import type { ProjectTag, UserTag } from "../types/index.js";

function getGitRemoteUrl(projectPath: string): string | null {
  const gitDir = join(projectPath, ".git");
  if (!existsSync(gitDir)) return null;

  const configPath = join(gitDir, "config");
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, "utf-8");
    const match = content.match(/url = (.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function getProjectName(projectPath: string): string {
  return basename(projectPath);
}

function getUserInfo(): { email: string; name: string } {
  try {
    const configPath = join(homedir(), ".gitconfig");
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const emailMatch = content.match(/email = (.+)/);
      const nameMatch = content.match(/name = (.+)/);
      return {
        email: emailMatch ? emailMatch[1].trim() : "unknown",
        name: nameMatch ? nameMatch[1].trim() : "Unknown User",
      };
    }
  } catch {}
  return { email: "unknown", name: "Unknown User" };
}

export function getProjectTag(projectPath: string): ProjectTag {
  const projectName = getProjectName(projectPath);
  const gitUrl = getGitRemoteUrl(projectPath);

  const tag = projectPath.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();

  return {
    tag,
    displayName: projectName,
    projectPath,
    projectName,
  };
}

export function getUserTag(): UserTag {
  const user = getUserInfo();
  return {
    userEmail: user.email,
    userName: user.name,
  };
}

export function getTags(projectPath: string): {
  project: ProjectTag;
  user: UserTag;
} {
  return {
    project: getProjectTag(projectPath),
    user: getUserTag(),
  };
}
