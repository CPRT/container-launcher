
export interface OptionConfig {
  image: string;
  command?: string[];
}

const image = "cprtsoftware/rover:arm64";

export const launchOptions: Record<string, OptionConfig> = {
  core: {
    image: image,
    command: ["ros2", "launch", "bringup", "core.launch.py"],
  },
  drive: {
    image: image,
    command: ["ros2", "launch", "bringup", "drive.launch.py"],
  },
  videoStreaming: {
    image: image,
    command: ["ros2", "launch", "bringup", "video_streaming.launch.py"],
  },
  arm: {
    image: image,
    command: ["ros2", "launch", "bringup", "arm.launch.py"],
  },
  joy: {
    image: image,
    command: ["ros2", "run", "joy", "joy_node"],
  },
};