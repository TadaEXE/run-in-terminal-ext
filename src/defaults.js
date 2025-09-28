export const HOST_NAME = "com.tada.run_in_terminal";

export const DEFAULTS = {
  shellOverride: "",
  dangerousSubstrings: [
    "rm -rf /",
    "rm -rf",
    "mkfs",
    ":(){:|:&};:",
    "dd if=",
    "chmod 777 /",
    "chown -R /",
    "shutdown",
    "reboot",
    "poweroff",
    "halt"
  ],
  confirmOnDanger: true
};

