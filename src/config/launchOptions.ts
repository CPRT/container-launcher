
export interface OptionConfig {
  image: string;
  command?: string[];
}

const image = "cprtsoftware/cprt_rover_24:jetson";

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
  localization: {
    image: image,
    command: ["ros2", "launch", "bringup", "localization.launch.py"],
  },
  navigation: {
    image: image,
    command: ["ros2", "launch", "bringup", "navigation.launch.py"],
  },
  science: {
    image: image,
    command: ["ros2", "launch", "bringup", "science.launch.py"],
  },
};