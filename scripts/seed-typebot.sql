-- Published OptionBrains bot. Sign-in, account, and support replies are handled by the gateway.
INSERT INTO typebot."User" (id, email, name, "createdAt", "lastActivityAt", "updatedAt", "onboardingCategories")
VALUES ('ob_user_admin','admin@optionbrains.com','OptionBrains Admin',NOW(),NOW(),NOW(),'[]'::jsonb)
ON CONFLICT (id) DO NOTHING;
INSERT INTO typebot."Workspace" (id, name, plan, "createdAt", "updatedAt", "additionalChatsIndex", "additionalStorageIndex", "isQuarantined", "isSuspended", "isPastDue")
VALUES ('ob_workspace','OptionBrains','UNLIMITED',NOW(),NOW(),0,0,false,false,false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO typebot."MemberInWorkspace" ("userId", "workspaceId", role, "createdAt", "updatedAt")
VALUES ('ob_user_admin','ob_workspace','ADMIN',NOW(),NOW())
ON CONFLICT ("userId","workspaceId") DO NOTHING;
WITH bot AS (
  SELECT 'ob_typebot_support'::text AS id, 'ob-support'::text AS public_id,
  '[
    {"id":"group_welcome","title":"Welcome","graphCoordinates":{"x":0,"y":0},"blocks":[
      {"id":"bubble_hi","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"Welcome to OptionBrains."}]},
        {"type":"p","children":[{"text":"Choose one option, or reply Menu anytime to start again."}]}
      ]}},
      {"id":"input_menu","type":"choice input","items":[
        {"id":"opt_signin","outgoingEdgeId":"edge_signin","content":"Sign in"},
        {"id":"opt_status","outgoingEdgeId":"edge_status","content":"My account"},
        {"id":"opt_support","outgoingEdgeId":"edge_support","content":"Talk to support"}
      ],"options":{"isMultipleChoice":false}}
    ]},
    {"id":"group_signin","title":"Sign in","graphCoordinates":{"x":520,"y":-220},"blocks":[
      {"id":"bubble_signin","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"Reply with the email on your OptionBrains account."}]},
        {"type":"p","children":[{"text":"We will email you a 6-digit code. Reply with that code here, then open the link to continue on the website."}]}
      ]}},
      {"id":"input_email_signin","type":"text input","outgoingEdgeId":"edge_signin_done","options":{"labels":{"placeholder":"Email","button":"Send"}}}
    ]},
    {"id":"group_signin_done","title":"Code sent","graphCoordinates":{"x":980,"y":-220},"blocks":[
      {"id":"bubble_signin_done","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"Check that inbox for the code, then reply with the 6 digits."}]}
      ]}}
    ]},
    {"id":"group_status","title":"My account","graphCoordinates":{"x":520,"y":40},"blocks":[
      {"id":"bubble_status","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"Reply with the email on your OptionBrains account."}]},
        {"type":"p","children":[{"text":"We will send your plan and verification status."}]}
      ]}},
      {"id":"input_email_status","type":"text input","outgoingEdgeId":"edge_status_done","options":{"labels":{"placeholder":"Email","button":"Send"}}}
    ]},
    {"id":"group_status_done","title":"Account reply","graphCoordinates":{"x":980,"y":40},"blocks":[
      {"id":"bubble_status_done","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"If this chat is on WhatsApp, your plan and verification status are on the way."}]}
      ]}}
    ]},
    {"id":"group_support","title":"Support","graphCoordinates":{"x":520,"y":300},"blocks":[
      {"id":"bubble_support","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"Write your question in one message."}]},
        {"type":"p","children":[{"text":"You can also email support@optionbrains.com."}]}
      ]}},
      {"id":"input_support","type":"text input","outgoingEdgeId":"edge_support_done","options":{"labels":{"placeholder":"Your question","button":"Send"},"isLong":true}}
    ]},
    {"id":"group_support_done","title":"Support received","graphCoordinates":{"x":980,"y":300},"blocks":[
      {"id":"bubble_support_done","type":"text","content":{"richText":[
        {"type":"p","children":[{"text":"Thanks. The team can see your message. Reply Menu to start again."}]}
      ]}}
    ]}
  ]'::jsonb AS groups,
  '[
    {"id":"edge_start","from":{"eventId":"evt_start"},"to":{"groupId":"group_welcome"}},
    {"id":"edge_signin","from":{"blockId":"input_menu","itemId":"opt_signin"},"to":{"groupId":"group_signin"}},
    {"id":"edge_status","from":{"blockId":"input_menu","itemId":"opt_status"},"to":{"groupId":"group_status"}},
    {"id":"edge_support","from":{"blockId":"input_menu","itemId":"opt_support"},"to":{"groupId":"group_support"}},
    {"id":"edge_signin_done","from":{"blockId":"input_email_signin"},"to":{"groupId":"group_signin_done"}},
    {"id":"edge_status_done","from":{"blockId":"input_email_status"},"to":{"groupId":"group_status_done"}},
    {"id":"edge_support_done","from":{"blockId":"input_support"},"to":{"groupId":"group_support_done"}}
  ]'::jsonb AS edges,
  '[{"id":"evt_start","type":"start","graphCoordinates":{"x":-320,"y":0},"outgoingEdgeId":"edge_start"}]'::jsonb AS events,
  '{"chat":{"hostBubbles":{"backgroundColor":"#111827","color":"#ffffff"},"guestBubbles":{"backgroundColor":"#F3F4F6","color":"#111827"},"buttons":{"backgroundColor":"#F97316","color":"#ffffff"}},"general":{"background":{"type":"Color","content":"#ffffff"}}}'::jsonb AS theme,
  '{"general":{"isBrandingEnabled":false},"metadata":{"title":"OptionBrains","description":"Sign in, account, and support"}}'::jsonb AS settings
)
INSERT INTO typebot."Typebot" (id, name, "publicId", "workspaceId", groups, variables, edges, theme, settings, events, version, "isArchived", "isClosed", "createdAt", "updatedAt")
SELECT bot.id, 'OptionBrains Research', bot.public_id, 'ob_workspace', bot.groups, '[]'::jsonb, bot.edges, bot.theme, bot.settings,
  bot.events, '6', false, false, NOW(), NOW()
FROM bot
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,
  groups=EXCLUDED.groups,
  edges=EXCLUDED.edges,
  events=EXCLUDED.events,
  theme=EXCLUDED.theme,
  settings=EXCLUDED.settings,
  "isArchived"=false,
  "isClosed"=false,
  "updatedAt"=NOW();
INSERT INTO typebot."PublicTypebot" (id, "typebotId", groups, variables, edges, theme, settings, events, version, "createdAt", "updatedAt")
SELECT 'ob_public_support', t.id, t.groups, t.variables, t.edges, t.theme, t.settings, t.events, t.version, NOW(), NOW()
FROM typebot."Typebot" t WHERE t.id='ob_typebot_support'
ON CONFLICT (id) DO UPDATE SET
  groups=EXCLUDED.groups,
  edges=EXCLUDED.edges,
  events=EXCLUDED.events,
  theme=EXCLUDED.theme,
  settings=EXCLUDED.settings,
  version=EXCLUDED.version,
  "updatedAt"=NOW();
