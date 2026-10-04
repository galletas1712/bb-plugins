import type { CSSProperties } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  Delete02Icon,
  Folder02Icon,
  FolderIcon,
  GitMergeIcon,
  GitPullRequestArrow,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Layers01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  MoreHorizontalIcon,
  SidebarLeftIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

const icons = {
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  ChevronUp: ArrowUp01Icon,
  ExternalLink: LinkSquare02Icon,
  Folder: FolderIcon,
  FolderOpen: Folder02Icon,
  GitMerge: GitMergeIcon,
  GitPullRequest: GitPullRequestIcon,
  GitPullRequestArrow,
  GitPullRequestClosed: GitPullRequestClosedIcon,
  GitPullRequestDraft: GitPullRequestDraftIcon,
  Layers: Layers01Icon,
  Loading: Loading03Icon,
  MessageSquare: BubbleChatIcon,
  MoreHorizontal: MoreHorizontalIcon,
  PanelLeft: SidebarLeftIcon,
  Trash2: Delete02Icon,
  X: Cancel01Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof icons;

export interface IconProps {
  name: IconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({ name, ...props }: IconProps) {
  return (
    <HugeiconsIcon
      icon={icons[name]}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    />
  );
}
