# Device status card

- Source: `artifacts/chat-app/components/DeviceEncryptionCard.tsx`
- States: registering, slow, registered, superseded, conflict, resetting, success, error.
- Behavior: guarded destructive reset with confirmation and disabled/busy states.
- Visual contract: semantic feedback, monospace public-key fingerprint, 44px action target.