# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: key-reset-recovery.spec.ts >> a member recovers a live encrypted room after resetting their device key
- Location: e2e/key-reset-recovery.spec.ts:113:1

# Error details

```
Error: locator.fill: Target page, context or browser has been closed
Call log:
  - waiting for getByPlaceholder('Email address')

```

```
TimeoutError: Step timeout of 60000ms exceeded.
```

# Test source

```ts
  75  |     await verificationCode.fill("424242");
  76  |     await page.getByText("Verify", { exact: true }).click();
  77  |     await Promise.race([
  78  |       setupName.waitFor({ state: "visible" }),
  79  |       roomList.waitFor({ state: "visible" }),
  80  |     ]);
  81  |   }
  82  |   if (await setupName.isVisible()) {
  83  |     await setupName.fill(user.username);
  84  |     await page.getByText("Enter workspace", { exact: true }).click();
  85  |   }
  86  |   await roomList.waitFor({ state: "visible" });
  87  |   return { context, page };
  88  | }
  89  | 
  90  | function roomJoinButton(page: Page, roomName: string) {
  91  |   const escapedName = roomName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  92  |   return page.getByRole("button", {
  93  |     name: new RegExp(`^Join ${escapedName}, \\d+ online$`),
  94  |   });
  95  | }
  96  | 
  97  | async function readMemberEnvelope(roomId: string, userId: string) {
  98  |   const [envelope] = await db
  99  |     .select({
  100 |       ciphertext: roomKeyEnvelopesTable.ciphertext,
  101 |       senderPublicKey: roomKeyEnvelopesTable.senderPublicKey,
  102 |     })
  103 |     .from(roomKeyEnvelopesTable)
  104 |     .where(
  105 |       and(
  106 |         eq(roomKeyEnvelopesTable.roomId, roomId),
  107 |         eq(roomKeyEnvelopesTable.userId, userId),
  108 |       ),
  109 |     );
  110 |   return envelope;
  111 | }
  112 | 
  113 | test("a member recovers a live encrypted room after resetting their device key", async ({
  114 |   browser,
  115 | }) => {
  116 |   // Two independent Clerk sign-ins plus Expo's cold browser bundle can take
  117 |   // longer than the banned-room path before the recovery assertions begin.
  118 |   test.setTimeout(270_000);
  119 |   test.skip(
  120 |     !chatUrl || !apiUrl || !publishableKey || !secretKey,
  121 |     "E2E_CHAT_URL, E2E_API_URL, and Clerk development keys are required",
  122 |   );
  123 | 
  124 |   const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  125 |   let roomId = "";
  126 |   const roomName = `Key recovery ${suffix}`;
  127 | 
  128 |   const historyMessage = `Readable from before reset ${suffix}`;
  129 |   const postResetMessage = `Readable after reset ${suffix}`;
  130 |   const password = `E2e-${suffix}-Room!9`;
  131 |   const clerkClient = createClerkClient({ publishableKey, secretKey });
  132 |   const users: DisposableUser[] = [];
  133 |   const clerkUserIds: string[] = [];
  134 |   const contexts: BrowserContext[] = [];
  135 |   let testFailure: unknown;
  136 | 
  137 |   try {
  138 |     await test.step(
  139 |       "provision creator and member accounts",
  140 |       async () => {
  141 |         for (const role of ["creator", "member"] as const) {
  142 |           const email = `key-reset-${role}-${suffix}+clerk_test@example.com`;
  143 |           const username =
  144 |             role === "creator" ? `Creator ${suffix}` : `Member ${suffix}`;
  145 |           const created = await withClerkRetry(`create ${role} user`, () =>
  146 |             clerkClient.users.createUser({
  147 |               emailAddress: [email],
  148 |               password,
  149 |               firstName: role === "creator" ? "Creator" : "Member",
  150 |               lastName: "E2E",
  151 |               skipLegalChecks: true,
  152 |               privateMetadata: { purpose: "key-reset-recovery-e2e" },
  153 |             }),
  154 |           );
  155 |           clerkUserIds.push(created.id);
  156 |           const apiSession = await withClerkRetry(`create ${role} session`, () =>
  157 |             clerkClient.sessions.createSession({ userId: created.id }),
  158 |           );
  159 |           const token = await withClerkRetry(`mint ${role} token`, () =>
  160 |             clerkClient.sessions.getToken(apiSession.id, undefined, 300),
  161 |           );
  162 |           users.push({
  163 |             id: created.id,
  164 |             email,
  165 |             password,
  166 |             token: token.jwt,
  167 |             username,
  168 |           });
  169 |         }
  170 |       },
  171 |       { timeout: PHASE_TIMEOUTS.provisionUsers },
  172 |     );
  173 | 
  174 |     let creator!: SignedInPage;
> 175 |     await test.step(
      |     ^ TimeoutError: Step timeout of 60000ms exceeded.
  176 |       "sign in creator and create encrypted room",
  177 |       async () => {
  178 |         creator = await createSignedInPage(browser, users[0]!, contexts);
  179 |         await creator.page.getByTestId("new-room-button").click();
  180 |         await creator.page.getByTestId("room-name-input").fill(roomName);
  181 |         await Promise.all([
  182 |           creator.page.waitForURL(/\/room\/[^/?#]+/),
  183 |           creator.page.getByTestId("room-submit-button").click(),
  184 |         ]);
  185 |         roomId = decodeURIComponent(
  186 |           new URL(creator.page.url()).pathname
  187 |             .split("/")
  188 |             .filter(Boolean)
  189 |             .at(-1) ?? "",
  190 |         );
  191 |         expect(roomId).not.toBe("");
  192 |       },
  193 |       { timeout: PHASE_TIMEOUTS.signInAndCreateRoom },
  194 |     );
  195 | 
  196 |     let member!: SignedInPage;
  197 |     let originalEnvelope!: NonNullable<
  198 |       Awaited<ReturnType<typeof readMemberEnvelope>>
  199 |     >;
  200 |     await test.step(
  201 |       "sign in member and receive initial room key",
  202 |       async () => {
  203 |         member = await createSignedInPage(browser, users[1]!, contexts);
  204 |         await roomJoinButton(member.page, roomName).click();
  205 |         await expect(
  206 |           creator.page.getByTestId("room-participant-count"),
  207 |         ).toHaveText("2 people");
  208 |         await expect(member.page.getByTestId("room-key-waiting")).toBeHidden();
  209 |         await expect
  210 |           .poll(() => readMemberEnvelope(roomId, users[1]!.id))
  211 |           .toBeTruthy();
  212 |         const envelope = await readMemberEnvelope(roomId, users[1]!.id);
  213 |         expect(envelope).toBeTruthy();
  214 |         originalEnvelope = envelope!;
  215 |       },
  216 |       { timeout: PHASE_TIMEOUTS.signInAndJoinRoom },
  217 |     );
  218 | 
  219 |     await test.step(
  220 |       "store encrypted history before key reset",
  221 |       async () => {
  222 |         await creator.page
  223 |           .getByTestId("room-composer-input")
  224 |           .fill(historyMessage);
  225 |         await creator.page.getByTestId("room-send-button").click();
  226 |         await expect(
  227 |           member.page.getByText(historyMessage, { exact: true }),
  228 |         ).toBeVisible();
  229 |       },
  230 |       { timeout: PHASE_TIMEOUTS.storeEncryptedHistory },
  231 |     );
  232 | 
  233 |     let resetSession!: SignedInPage;
  234 |     await test.step(
  235 |       "reset member device key in a second session",
  236 |       async () => {
  237 |         // Keep the first member session in the room so the reset session's
  238 |         // later join takes the explicit user-key-changed recovery path.
  239 |         resetSession = await createSignedInPage(
  240 |           browser,
  241 |           users[1]!,
  242 |           contexts,
  243 |         );
  244 |         await resetSession.page.getByRole("tab", { name: /Profile/ }).click();
  245 |         await expect(
  246 |           resetSession.page.getByTestId("device-key-status"),
  247 |         ).toHaveText("Replaced by another device or session");
  248 |         const fingerprint = resetSession.page.getByTestId(
  249 |           "device-key-fingerprint",
  250 |         );
  251 |         const originalFingerprint = await fingerprint.innerText();
  252 | 
  253 |         resetSession.page.once("dialog", (dialog) => dialog.accept());
  254 |         await resetSession.page.getByTestId("reset-device-key-button").click();
  255 |         await expect(
  256 |           resetSession.page.getByTestId("device-key-feedback"),
  257 |         ).toContainText("New device key created");
  258 |         await expect(fingerprint).not.toHaveText(originalFingerprint);
  259 |         await expect(
  260 |           resetSession.page.getByTestId("device-key-status"),
  261 |         ).toHaveText("Registered with your account");
  262 | 
  263 |         await resetSession.page.evaluate(
  264 |           ({ memberId, recoveredRoomId }) => {
  265 |             globalThis.localStorage.removeItem(
  266 |               `devstudio_roomkey:${memberId}:${recoveredRoomId}`,
  267 |             );
  268 |           },
  269 |           { memberId: users[1]!.id, recoveredRoomId: roomId },
  270 |         );
  271 |         await resetSession.page.reload();
  272 |         await expect(
  273 |           resetSession.page.getByTestId("device-key-status"),
  274 |         ).toHaveText("Registered with your account");
  275 |       },
```