-- 为 workbench_data 表新增 sharing 列（JSONB），存储每个用户的「模块数据共享开关」：{ moduleId: true/false }
-- 该列用于「模块权限 + 数据共享」需求：用户可配置自己的哪些模块数据对他人可见。
-- 内联展示（他人在自己模块看到你的共享数据）为第二期，本期仅打通数据层。

-- 幂等：列已存在则跳过
ALTER TABLE workbench_data ADD COLUMN IF NOT EXISTS sharing JSONB DEFAULT '{}'::jsonb;

-- 验证（可选）：查看各用户 sharing 配置，应为 {} 或已配置的对象
-- SELECT user_id, sharing FROM workbench_data LIMIT 5;
