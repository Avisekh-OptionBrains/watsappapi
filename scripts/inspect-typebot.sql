SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'typebot' AND table_name = 'Typebot'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'typebot' AND table_name = 'PublicTypebot'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'typebot' AND table_name = 'User'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'typebot' AND table_name = 'Workspace'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'typebot' AND table_name = 'MemberInWorkspace'
ORDER BY ordinal_position;

SELECT id, email FROM typebot."User" LIMIT 5;
SELECT id, name FROM typebot."Workspace" LIMIT 5;
SELECT id, name, "publicId" FROM typebot."Typebot" LIMIT 5;
