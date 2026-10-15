# Aimighty team invites: steps and message (drafts for the owner)

**Status: draft, 15 Oct 2026. No invitation has been created.** Nothing here has a code or a link in it. Owner, 15 Oct 22:15: "Prepare invite links to the house workspace (I send them; one admin, the rest members)." Everything below is from the code on `redesign/integration` and `release/1`: the Team invitations (`app/api/team/route.ts`, `lib/teamInvitations.ts`, `components/graphite/settings/team/TeamSection.tsx`, `app/(auth)/invite/[code]/page.tsx`).

## What the owner does, in the product
Sign in as the owner of the house workspace, **on the address the team will use** (for example particl.si): the link is built from the address in your browser bar.
1. Open **Settings › Team** (the house workspace has the new interface on; the page is `/suites?view=workspace&tab=team`). Only the owner and admins see it.
2. Press **Invite · one-time link**. Type the person's **Name** and **Email**, press **Make the link**.
3. Press **Copy link**. The link reads `<address>/invite/<code>`. Paste it into your own message to that person (the draft below). Do this once per person.
4. **One admin, the rest members.** The form always makes a **member**. Make the first person (the one to be admin) first. Once they have joined, find them in the People list and press **Change role**, then **Admin** (only the owner sees that button). Everyone else stays a member.
5. To undo: a waiting invite has **Revoke** (the link stops working) and, where email is set up, **Resend**. A new link replaces a spoiled one.

## What the link does (so the message is right)
- **Works once, for 7 days.** After it is used or has expired the page says so and you make a new one.
- **Tied to the email you typed.** Only that address can take it. Type it exactly.
- **A new person** chooses a password, ticks the agreement to the terms and content policy, and joins the workspace. **Someone who already has an account** signs in as that address and presses Join.
- **Google sign-in** still needs an invite. Google's sign-in is in Google's Testing mode until the owner publishes it (`docs/redesign-progress.md`, 12 Oct), so outside testers should use a password, or publish it first.
- **Seats:** open invitations count as members. A workspace on the Invite plan allows 3 members, so the form would refuse the fourth with "The Invite plan allows 3 members, counting open invitations. Revoke one or move to a larger plan." A workspace with no plan has no limit. Check the house workspace's plan if a refusal shows.

## One thing to check first: email
**If email is set up on the server** (the names `RESEND_API_KEY` and `MAIL_FROM`; I did not read the environment, so I do not know), pressing **Make the link** also **emails the invitation to that address** straight away, from the product ("<you> (<workspace>) invited you to particl studio"), because the form does not turn the email off. And a new person's account can then only be made from the **link in that email**: opened from your pasted link alone, the page shows "Email me the link" instead of the password form. So either (a) let the email go and send your message too, saying "use the email we just sent or press Email me the link", or (b) ask the build team to add a "don't email" option to the form (the route already supports `send: false`; the form does not set it). **If email is not set up**, the pasted link alone takes the person straight to the password form.

## The message to send with each link
Two sentences, plain, no secrets. Replace the brackets.

> Hi [NAME], you're invited to try Particl with the Aimighty team: open [LINK] to set a password and join (it works once, for 7 days). When you're in, follow the first test script [SCRIPT LINK] and tell us what breaks on the feedback board https://claude.ai/artifact/RwiYcD2sVpLiLw7kGyt4wC.

For the admin, change the first sentence's ending: "...to set a password and join as an admin (it works once, for 7 days)." (The role is set after they join: step 4.)

Never post a link in a shared channel: send each to its own person.
