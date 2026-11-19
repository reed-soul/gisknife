export interface ChinaAdminEntry {
  adcode: string
  name: string
  english: string
  level: 'country' | 'province' | 'city' | 'district'
  parentAdcode?: string
  aliases: string[]
}

/**
 * Lightweight adcode directory (no vector geometry bundled) used purely for
 * deterministic provider routing across DataV / Tianditu / static indexes.
 */
export const CHINA_ADMIN_INDEX: ChinaAdminEntry[] = [
  { adcode: '100000', name: '中华人民共和国', english: 'China', level: 'country', aliases: ['中国', 'china', 'prc'] },
  // Municipalities & Provinces
  { adcode: '110000', name: '北京市', english: 'Beijing', level: 'province', parentAdcode: '100000', aliases: ['北京', 'beijing'] },
  { adcode: '120000', name: '天津市', english: 'Tianjin', level: 'province', parentAdcode: '100000', aliases: ['天津', 'tianjin'] },
  { adcode: '310000', name: '上海市', english: 'Shanghai', level: 'province', parentAdcode: '100000', aliases: ['上海', 'shanghai'] },
  { adcode: '500000', name: '重庆市', english: 'Chongqing', level: 'province', parentAdcode: '100000', aliases: ['重庆', 'chongqing'] },
  { adcode: '440000', name: '广东省', english: 'Guangdong', level: 'province', parentAdcode: '100000', aliases: ['广东', 'guangdong'] },
  { adcode: '330000', name: '浙江省', english: 'Zhejiang', level: 'province', parentAdcode: '100000', aliases: ['浙江', 'zhejiang'] },
  { adcode: '320000', name: '江苏省', english: 'Jiangsu', level: 'province', parentAdcode: '100000', aliases: ['江苏', 'jiangsu'] },
  { adcode: '510000', name: '四川省', english: 'Sichuan', level: 'province', parentAdcode: '100000', aliases: ['四川', 'sichuan'] },
  { adcode: '420000', name: '湖北省', english: 'Hubei', level: 'province', parentAdcode: '100000', aliases: ['湖北', 'hubei'] },
  { adcode: '610000', name: '陕西省', english: 'Shaanxi', level: 'province', parentAdcode: '100000', aliases: ['陕西', 'shaanxi'] },
  { adcode: '350000', name: '福建省', english: 'Fujian', level: 'province', parentAdcode: '100000', aliases: ['福建', 'fujian'] },
  { adcode: '370000', name: '山东省', english: 'Shandong', level: 'province', parentAdcode: '100000', aliases: ['山东', 'shandong'] },
  { adcode: '430000', name: '湖南省', english: 'Hunan', level: 'province', parentAdcode: '100000', aliases: ['湖南', 'hunan'] },
  // Major Prefectures / Cities
  { adcode: '440100', name: '广州市', english: 'Guangzhou', level: 'city', parentAdcode: '440000', aliases: ['广州', 'guangzhou'] },
  { adcode: '440300', name: '深圳市', english: 'Shenzhen', level: 'city', parentAdcode: '440000', aliases: ['深圳', 'shenzhen'] },
  { adcode: '440600', name: '佛山市', english: 'Foshan', level: 'city', parentAdcode: '440000', aliases: ['佛山', 'foshan'] },
  { adcode: '441900', name: '东莞市', english: 'Dongguan', level: 'city', parentAdcode: '440000', aliases: ['东莞', 'dongguan'] },
  { adcode: '440400', name: '珠海市', english: 'Zhuhai', level: 'city', parentAdcode: '440000', aliases: ['珠海', 'zhuhai'] },
  { adcode: '330100', name: '杭州市', english: 'Hangzhou', level: 'city', parentAdcode: '330000', aliases: ['杭州', 'hangzhou'] },
  { adcode: '320100', name: '南京市', english: 'Nanjing', level: 'city', parentAdcode: '320000', aliases: ['南京', 'nanjing'] },
  { adcode: '320500', name: '苏州市', english: 'Suzhou', level: 'city', parentAdcode: '320000', aliases: ['苏州', 'suzhou'] },
  { adcode: '510100', name: '成都市', english: 'Chengdu', level: 'city', parentAdcode: '510000', aliases: ['成都', 'chengdu'] },
  { adcode: '420100', name: '武汉市', english: 'Wuhan', level: 'city', parentAdcode: '420000', aliases: ['武汉', 'wuhan'] },
  { adcode: '610100', name: '西安市', english: "Xi'an", level: 'city', parentAdcode: '610000', aliases: ['西安', 'xian', "xi'an"] },
  { adcode: '350200', name: '厦门市', english: 'Xiamen', level: 'city', parentAdcode: '350000', aliases: ['厦门', 'xiamen'] },
  // Key Districts (Shenzhen & Foshan & Beijing & Shanghai)
  { adcode: '440303', name: '罗湖区', english: 'Luohu', level: 'district', parentAdcode: '440300', aliases: ['罗湖', '深圳罗湖', '深圳罗湖区', 'luohu'] },
  { adcode: '440304', name: '福田区', english: 'Futian', level: 'district', parentAdcode: '440300', aliases: ['福田', '深圳福田', '深圳福田区', 'futian'] },
  { adcode: '440305', name: '南山区', english: 'Nanshan', level: 'district', parentAdcode: '440300', aliases: ['南山', '南山区', '深圳南山', '深圳南山区', 'nanshan', 'nanshan shenzhen'] },
  { adcode: '440306', name: '宝安区', english: 'Baoan', level: 'district', parentAdcode: '440300', aliases: ['宝安', '深圳宝安', 'baoan'] },
  { adcode: '440307', name: '龙岗区', english: 'Longgang', level: 'district', parentAdcode: '440300', aliases: ['龙岗', '深圳龙岗', 'longgang'] },
  { adcode: '440604', name: '禅城区', english: 'Chancheng', level: 'district', parentAdcode: '440600', aliases: ['禅城', '佛山禅城', 'chancheng'] },
  { adcode: '440605', name: '南海区', english: 'Nanhai', level: 'district', parentAdcode: '440600', aliases: ['南海', '佛山南海', 'nanhai'] },
  { adcode: '440606', name: '顺德区', english: 'Shunde', level: 'district', parentAdcode: '440600', aliases: ['顺德', '佛山顺德', 'shunde'] },
  { adcode: '110105', name: '朝阳区', english: 'Chaoyang', level: 'district', parentAdcode: '110000', aliases: ['北京朝阳', '朝阳区', 'chaoyang'] },
  { adcode: '110108', name: '海淀区', english: 'Haidian', level: 'district', parentAdcode: '110000', aliases: ['海淀', '北京海淀', 'haidian'] },
  { adcode: '310115', name: '浦东新区', english: 'Pudong', level: 'district', parentAdcode: '310000', aliases: ['浦东', '上海浦东', 'pudong'] },
]

export function normalizeChinaQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^中国\s*/i, '')
    .replace(/^china\s*,?\s*/i, '')
    .replace(/[,，\s]+/g, ' ')
    .trim()
}

export function lookupChinaAdmin(query: string): ChinaAdminEntry | undefined {
  const norm = normalizeChinaQuery(query)
  if (!norm) return undefined

  if (/^\d{6}$/.test(norm)) {
    return CHINA_ADMIN_INDEX.find((e) => e.adcode === norm)
  }

  // Exact match on name, english, or aliases first
  for (const entry of CHINA_ADMIN_INDEX) {
    if (
      entry.name.toLowerCase() === norm ||
      entry.english.toLowerCase() === norm ||
      entry.aliases.some((a) => a.toLowerCase() === norm)
    ) {
      return entry
    }
  }

  // Composite check (e.g. "深圳市南山区" or "广东佛山" -> longest matching district/city alias)
  const sorted = [...CHINA_ADMIN_INDEX].sort((a, b) => {
    const rank = { district: 0, city: 1, province: 2, country: 3 }
    return rank[a.level] - rank[b.level]
  })
  for (const entry of sorted) {
    if (entry.level === 'country') continue
    if (
      norm.endsWith(entry.name.toLowerCase()) ||
      entry.aliases.some((a) => a.length >= 2 && norm.includes(a.toLowerCase()))
    ) {
      return entry
    }
  }

  return undefined
}
