// test-send.js
const nodemailer = require('nodemailer');

const user = process.env.GMAIL_USER;
const pass = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');

(async () => {
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass }
    });

    await transporter.verify();
    console.log('✅ verify OK');

    const info = await transporter.sendMail({
      from: user,
      to: user, // まずは自分宛に送る（管理用アドレス）
      subject: 'テスト送信 - 松乃木飯店',
      text: 'これは送信テストです。'
    });

    console.log('📧 sendMail success:', info);
  } catch (err) {
    console.error('❌ send error:', err);
  }
})();
