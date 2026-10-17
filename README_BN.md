# X-EXTRA EARNING BOT (Render + GitHub)

বাংলা Telegram bot: balance, referral, tasks, withdrawal requests এবং admin review। এটি starter project; আয় বা পেমেন্ট নিশ্চিত করে না।

## 1) Telegram bot বানাও
1. Telegram-এ `@BotFather` খুলো।
2. `/newbot` পাঠিয়ে নাম ও username সেট করো।
3. Token কপি করো, কাউকে পাঠাবে না।

## 2) নিজের Admin ID জানো
Telegram-এ `@userinfobot` বা বিশ্বস্ত ID bot থেকে numeric user ID দেখো। `ADMIN_ID`-তে নিজের ID বসাবে। ID-ও public repo-তে রাখার দরকার নেই।

## 3) GitHub-এ আপলোড (মোবাইল)
1. GitHub-এ নতুন repository বানাও: `x-extra-earning-bot`।
2. ZIP extract করে সব project files repo-তে upload করো। `.env` ফাইল কখনো upload করবে না।
3. `render.yaml`, `index.js`, `package.json`, `.gitignore`, `README_BN.md` থাকতে হবে।

## 4) Render deploy
1. Render.com-এ GitHub দিয়ে sign in করো।
2. New + → Blueprint, repo নির্বাচন করো; অথবা New Web Service করে Build `npm install`, Start `npm start` দাও।
3. Blueprint-এ database তৈরি হলে free plan/region availability Render-এর বর্তমান নিয়মের ওপর নির্ভর করবে।
4. Web Service → Environment-এ যোগ করো:
   - `BOT_TOKEN` = BotFather token
   - `ADMIN_ID` = তোমার numeric Telegram ID
   - `DATABASE_URL` = Render PostgreSQL-এর connection string (Blueprint database bind করলে auto-set হতে পারে)
   - `REFERRAL_BONUS` = `10` (পয়েন্ট)
   - `MIN_WITHDRAW` = `100` (পয়েন্ট)
5. Deploy শেষ হলে service-এর `/health` URL খুলে `{"ok":true}` দেখো।
6. Telegram-এ bot-এ `/start` পাঠাও।

## 5) Admin commands
- `/admin` — নির্দেশনা
- `/addtask শিরোনাম | https://example.com | 20`
- `/tasksadmin` — task list
- `/claims` — pending task claims approve/reject
- `/withdrawals` — pending withdrawals
- `/stats` — basic statistics
- `/credit USER_ID POINTS` — পয়েন্ট যোগ

Task claim button শুধু অনুরোধ জমা করে; এটি বাইরের কাজ যাচাই করতে পারে না। অ্যাডমিন প্রমাণ যাচাই করে `/claims` থেকে approve করবে।

## 6) গুরুত্বপূর্ণ পেমেন্ট ও নিরাপত্তা
- Points are internal reward points, not automatically cash. `POINTS_PER_TAKA` কেবল ভবিষ্যতের conversion planning-এর জন্য; এই starter bot-এ এটি স্বয়ংক্রিয় নগদ রূপান্তর/পেমেন্ট চালায় না।
- টাকা দিতে হলে প্রকৃত sponsor/client revenue বা অ্যাডমিনের তহবিল থাকতে হবে। কোনো আয় বা payout নিশ্চিত নয়।
- Withdrawal method/account private chat-এ পাঠাতে হবে। অ্যাডমিনের কাছে payment account পাঠানো হয়; তাই শুধু বিশ্বস্ত অ্যাডমিন ID ব্যবহার করো।
- `BOT_TOKEN` কখনো GitHub-এ commit করবে না। প্রকাশ হয়ে গেলে BotFather দিয়ে token revoke/regenerate করো।
- Render free service/database availability, sleeping, quotas, retention ও limits পরিবর্তনশীল; dashboard-এ বর্তমান শর্ত দেখো। Production-এর আগে database backup, privacy notice, fraud checks, payout policy ও age/region compliance যোগ করো।
- referral bonus বর্তমানে নতুন invited user `/start` করলে যোগ হয়; এটি advanced Sybil/fraud detection নয়। বড় পরিসরে ব্যবহার করার আগে rate limits ও review যোগ করা জরুরি।
