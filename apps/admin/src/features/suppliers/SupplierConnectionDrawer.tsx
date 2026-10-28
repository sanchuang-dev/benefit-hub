import { Alert, Button, Drawer, Form, Input, Space, Typography, App as AntdApp } from 'antd';
import { useEffect } from 'react';
import {
  useConnectionEditorQuery,
  useConnectionSave,
  type ConnectionInput,
} from './connection-editor';

const { Text } = Typography;

interface EditorFields {
  baseUrl: string;
  appKey: string;
  appSecret: string;
}

export function SupplierConnectionDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm<EditorFields>();
  const query = useConnectionEditorQuery(open);
  const save = useConnectionSave();
  const { message } = AntdApp.useApp();
  const connection = query.data?.connection;
  const mustEnterCredentials = connection?.source !== 'database';

  useEffect(() => {
    if (!open || !connection) return;
    form.setFieldsValue({
      baseUrl: connection.baseUrl || 'https://dev-api.isunpow.com',
      appKey: '',
      appSecret: '',
    });
  }, [open, connection, form]);

  const submit = async (values: EditorFields) => {
    if (!connection) return;
    const input: ConnectionInput = {
      baseUrl: values.baseUrl.trim(),
      version: connection.version,
      ...(values.appKey ? { appKey: values.appKey } : {}),
      ...(values.appSecret ? { appSecret: values.appSecret } : {}),
    };
    try {
      await save.mutateAsync(input);
      form.setFieldsValue({ appKey: '', appSecret: '' });
      message.success('连接配置已加密保存');
      onClose();
    } catch {
      // Error stays visible in the drawer. No secret is logged or reflected.
    }
  };

  return (
    <Drawer
      title="上力 · 接入配置"
      open={open}
      onClose={onClose}
      size={520}
      destroyOnHidden
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={save.isPending}
            disabled={!connection?.canSave}
            onClick={() => void form.submit()}
          >
            保存配置
          </Button>
        </Space>
      }
    >
      {query.isError ? (
        <Alert type="error" showIcon title="读取接入配置失败" description={query.error.message} />
      ) : null}
      {connection && !connection.canSave ? (
        <Alert
          type="warning"
          showIcon
          title="服务器加密主密钥尚未就绪"
          description="需要运维一次性配置独立的加密主密钥，才能安全保存数据库中的供应商凭证。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Form<EditorFields>
        form={form}
        layout="vertical"
        onFinish={(values) => void submit(values)}
        autoComplete="off"
      >
        <Form.Item
          name="baseUrl"
          label="上力 Open API 地址"
          rules={[{ required: true, type: 'url', message: '请输入合法 HTTPS API 地址' }]}
        >
          <Input placeholder="https://dev-api.isunpow.com" />
        </Form.Item>
        <Form.Item
          name="appKey"
          label="AppKey"
          rules={[{ required: mustEnterCredentials, message: '首次保存请填写 AppKey' }]}
        >
          <Input.Password autoComplete="new-password" placeholder={mustEnterCredentials ? '请输入 AppKey' : '留空表示保留现有 AppKey'} />
        </Form.Item>
        <Form.Item
          name="appSecret"
          label="AppSecret"
          rules={[{ required: mustEnterCredentials, message: '首次保存请填写 AppSecret' }]}
        >
          <Input.Password autoComplete="new-password" placeholder={mustEnterCredentials ? '请输入 AppSecret' : '留空表示保留现有 AppSecret'} />
        </Form.Item>
      </Form>
      <Text type="secondary">
        密钥由服务端加密持久化，后续读取不需要重新输入。历史密钥不会在页面中回显。
        保存配置只改变只读连接凭证，不启用供应商派发或扣额。
      </Text>
      {save.isError ? (
        <Alert
          type="error"
          showIcon
          title="保存失败"
          description={save.error.message}
          style={{ marginTop: 16 }}
        />
      ) : null}
    </Drawer>
  );
}
