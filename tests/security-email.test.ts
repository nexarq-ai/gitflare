import { describe, expect, it, vi } from 'vitest';
import { deliverInvitation } from '../src/worker/email';

const input = { email: 'recipient@example.test', token: 'a'.repeat(64), workspaceName: '<script>Team</script> & Friends', origin: 'https://gitflare.example.test' };
function binding(send: ReturnType<typeof vi.fn>): SendEmail { return { send } as unknown as SendEmail; }
describe('native invitation email delivery', () => {
  it('sends structured text and escaped HTML from the installation sender', async () => {
    const send = vi.fn().mockResolvedValue({messageId:'message-id'});
    expect(await deliverInvitation({EMAIL:binding(send),EMAIL_FROM:'gitflare@sender.example.test'},input)).toEqual({status:'sent',messageId:'message-id'});
    const message = send.mock.calls[0][0];
    expect(message.from).toEqual({email:'gitflare@sender.example.test',name:'Gitflare'}); expect(message.to).toBe(input.email);
    expect(message.text).toContain(`https://gitflare.example.test/invite#token=${input.token}`);
    expect(message.html).not.toContain('<script>'); expect(message.html).toContain('&lt;script&gt;Team&lt;/script&gt; &amp; Friends');
    expect(message.html).toContain('24 hours');
  });
  it('reports absent configuration and provider failure without logging capabilities', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error(input.token),{code:'E_SENDER_NOT_VERIFIED'}));
    const logger = vi.spyOn(console,'error').mockImplementation(() => {});
    try {
      expect((await deliverInvitation({},input)).status).toBe('unconfigured');
      const failure = await deliverInvitation({EMAIL:binding(send),EMAIL_FROM:'sender@example.test'},input);
      expect(failure).toMatchObject({status:'error',code:'E_SENDER_NOT_VERIFIED'}); expect(JSON.stringify(failure)).not.toContain(input.token); expect(logger).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });
  it('does not send malformed recipients or unsafe invitation links', async () => {
    const send = vi.fn(); const env = {EMAIL:binding(send),EMAIL_FROM:'sender@example.test'};
    expect((await deliverInvitation(env,{...input,email:'a@example.test\r\nBcc: other@example.test'})).status).toBe('error');
    expect((await deliverInvitation(env,{...input,origin:'javascript:alert(1)'})).status).toBe('error');
    expect((await deliverInvitation(env,{...input,token:'" onclick="alert(1)'})).status).toBe('error');
    expect(send).not.toHaveBeenCalled();
  });
});
