
export interface OptionConfig {
  image: string;
  command?: string[];
}

const image = "cprtsoftware/rover:latest";

export const launchOptions: Record<string, OptionConfig> = {
  core: {
    image: image,
    command: ["ros2", "launch", "bringup", "core.launch.py"],
  },
  videoStreaming: {
    image: image,
    command: ["ros2", "launch", "video_streaming", "video_streaming.launch.py"],
  },
  driveAndArm: {
    image: image,
    command: ["ros2", "launch", "bringup", "control.launch.py"],
  },
  drive: {
    image: image,
    command: ["ros2", "launch", "bringup", "control.launch.py", "use_arm:=false"],
  },
  arm: {
    image: image,
    command: ["ros2", "launch", "bringup", "control.launch.py", "use_drive:=false"],
  },
  joy: {
    image: image,
    command: ["ros2", "run", "joy", "joy_node"],
  },
  slam: {
    image: image,
    command: ["ros2", "launch", "navigation", "slam.launch.py"],
  },
  navigation: {
    image: image,
    command: ["ros2", "launch", "navigation", "nav2.launch.py"],
  },
  commander: {
    image: image,
    command: ["ros2", "launch", "nav_commanders", "commander.launch.py"],
  },
  gps: {
    image: image,
    command: ["ros2", "launch", "gps", "rover.launch.py"],
  },
  scienceStreaming: {
    image: image,
    command: ["ros2", "launch", "video_streaming", "science_streaming.launch.py"],
  },
  science: {
    image: image,
    command: ["ros2", "launch", "bringup", "science.launch.py"],
  },
};
