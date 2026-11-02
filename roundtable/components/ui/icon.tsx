import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Archive03Icon,
  BubbleChatAddIcon,
  Copy01Icon,
  Delete02Icon,
  File01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusSignIcon,
  Settings01Icon,
  SquareIcon,
  Tick02Icon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons";

const icons = {
  Archive: Archive03Icon,
  Copy: Copy01Icon,
  Check: Tick02Icon,
  ExternalLink: LinkSquare02Icon,
  FileText: File01Icon,
  Loading: Loading03Icon,
  MessageSquarePlus: BubbleChatAddIcon,
  MoreHorizontal: MoreHorizontalIcon,
  Pause: PauseIcon,
  Play: PlayIcon,
  Plus: PlusSignIcon,
  Settings: Settings01Icon,
  Square: SquareIcon,
  Trash2: Delete02Icon,
  UserRoundPlus: UserAdd01Icon,
} as const;

type IconProps = {
  name: keyof typeof icons;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
};

export function Icon(props: IconProps) {
  const { name, ...attributes } = props;
  return <HugeiconsIcon icon={icons[name]} aria-hidden={attributes["aria-label"] ? undefined : true} {...attributes} />;
}
