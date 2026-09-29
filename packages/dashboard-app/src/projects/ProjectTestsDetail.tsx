import { useT } from '../i18n'
import { DetailEmpty } from '../shell/ThreeColumns'
import { SuiteDetail } from './SuiteDetail'
import type { ProjectTests } from './useProjectTests'

/** 项目页「测试」的右列：所选套件的详情；没有目录或没有选中时右列只留空白。 */
export function ProjectTestsDetail({ root, tests }: { root: string; tests: ProjectTests }): JSX.Element {
  const { t } = useT()
  const data = tests.catalog.status === 'ready' ? tests.catalog.data : null
  const view = data?.catalog
  const suite = view?.state === 'ok' ? view.suites.find((item) => item.id === tests.selectedId) : undefined
  if (data === null || view?.state !== 'ok' || suite === undefined) {
    return <DetailEmpty label={t('tests.project.empty')} testId="proj-suite-empty" />
  }
  return <SuiteDetail key={suite.id} root={root} suite={suite} services={view.services} knownFailures={data.knownFailures} workflow={tests.workflow} />
}
