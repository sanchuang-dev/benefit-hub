import { Alert, Card, Descriptions, Space, Tag, Typography } from 'antd';

const { Title, Paragraph, Text } = Typography;

/**
 * First-level product destinations.
 *
 * These routes deliberately do not invent persistent entities or pretend that
 * configuration APIs have shipped. Real management workflows require their
 * own authenticated backend contracts before enabling write controls.
 */
const modules = {
  suppliers: {
    title: '供应商管理',
    description: '供货方档案、接入能力、供货关系、成本与额度来源。',
    status: '供应商接入与商品目录',
    evidence: '已接入上力供应商档案与 D 商品目录查询，支持服务端加密保存接入凭证。',
    next: '后续由服务端提供供应商档案、接入状态、受控能力与来源记录；不凭页面推断实际余额或成本。',
  },
  values: {
    title: '价值换算',
    description: '面向下游应用的价值换算预设、计算预览与版本发布。',
    status: '价值换算规则服务尚未接入',
    evidence: '当前没有已发布的换算规则可供查询；不能把上力商品展示价当作三创换算结果或实际扣额。',
    next: '需要服务端持久化的源/目标单位、比率或固定值、精度与舍入、限额、生效期及不可变版本。',
  },
  interfaces: {
    title: '接口管理',
    description: '根据应用授权和已发布价值规则，生成、预览和发布可调用的接口。',
    status: '配置驱动的接口生成与发布尚未接入',
    evidence: '已有固定的受保护订单入站协议；尚无根据应用与换算配置动态生成、发布、停用 API 的服务。',
    next: '先建立服务端授权和规则版本，再生成真实可调用的受控路由、契约与使用说明；不提供假的发布按钮。',
  },
} as const;

export type PlatformModule = keyof typeof modules;

export function PlatformModulesPage({ module }: { module: PlatformModule }) {
  const info = modules[module];

  return (
    <div className="page">
      <header className="page-header">
        <Title level={1}>{info.title}</Title>
        <Paragraph type="secondary">{info.description}</Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <Alert
          type="info"
          showIcon
          title={info.status}
          description="本页面是独立的一级业务入口，但尚无可操作的管理数据源。未使用虚构列表、余额、规则或调用结果。"
        />
        <Card title="当前可确认的能力与边界">
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: 'known', label: '已知事实', children: info.evidence },
              { key: 'next', label: '业务接入条件', children: info.next },
              {
                key: 'state',
                label: '页面状态',
                children: <Tag>待接入真实管理接口</Tag>,
              },
            ]}
          />
          <Text type="secondary">
            已有业务系统、已发布换算预设和可调用接口必须从真实后端读取，本页不以示例数据冒充运营事实。
          </Text>
        </Card>
      </Space>
    </div>
  );
}
